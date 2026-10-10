import { isLevel } from './levels.js';
import type { Level, LogContext, Logger } from './types.js';

// Opt-in console capture (DESIGN §6.7): forward selected `console` methods into a logger so the
// `console.error` calls an application already has get a level, the trace stamp and redaction
// without touching call sites. Nothing here runs unless `captureConsole` is called.
//
// Core, not Node: no `util.format`, hence the small interpolator. The one real hazard is
// recursion — the console fallback transport and the logger's own warnings write to the console,
// so both resolve the ORIGINAL method through `uncaptured()` at call time, and a re-entrancy
// guard covers a user transport that writes to the console synchronously from `send()`.

/** The console methods that can be captured. */
export type ConsoleCaptureMethod = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace';

const METHODS: readonly ConsoleCaptureMethod[] = ['log', 'info', 'warn', 'error', 'debug', 'trace'];

type ConsoleFn = (...args: unknown[]) => void;

/** The shape `captureConsole` patches; the global `console` satisfies it. */
export type ConsoleCaptureTarget = Record<ConsoleCaptureMethod, ConsoleFn>;

export interface ConsoleCaptureOptions {
  /**
   * Which console methods forward, and at what level. Default `{ warn: 'warn', error: 'error' }`:
   * `console.log` carries framework chatter and platform log viewers already collect it, so
   * forwarding it is a choice. `false` (or an unknown level) leaves a method alone.
   */
  readonly levels?: Partial<Record<ConsoleCaptureMethod, Level | false>>;
  /** Default `true`: the original method still runs, so stdout and the platform viewer see the line. */
  readonly passthrough?: boolean;
  /** The console to patch. Default the global one; injectable for tests. */
  readonly console?: ConsoleCaptureTarget;
}

/** Puts the original methods back. Safe to call more than once. */
export type RestoreConsole = () => void;

const DEFAULT_LEVELS: Readonly<Partial<Record<ConsoleCaptureMethod, Level>>> = {
  warn: 'warn',
  error: 'error',
};

interface Capture {
  readonly originals: Readonly<Record<ConsoleCaptureMethod, ConsoleFn>>;
  readonly patched: Partial<Record<ConsoleCaptureMethod, ConsoleFn>>;
  readonly restore: RestoreConsole;
}

// Keyed by the patched object, so a test console and the global one are independent, and so a
// restored or garbage-collected target leaves nothing behind.
const CAPTURES = new WeakMap<object, Capture>();

let forwarding = false;

/**
 * Run `fn` with capture suspended: console calls inside it go straight to the originals. The
 * dispatchers wrap the synchronous part of `transport.send` in this, so a transport that writes
 * to the console cannot feed its own line back into the logger. A write made after an `await`
 * inside `send` is outside the guard — a custom transport should hold its own reference to the
 * original methods, as `ConsoleTransport` effectively does through `uncaptured()`.
 */
export function suppressingCapture<T>(fn: () => T): T {
  const previous = forwarding;
  forwarding = true;
  try {
    return fn();
  } finally {
    forwarding = previous;
  }
}

/**
 * The original `method` of `target` if it is captured, else its current one. The console
 * fallback transport and the internal-error reporter write through this so capture can never
 * feed the logger its own output.
 */
export function uncaptured(target: object, method: ConsoleCaptureMethod): ConsoleFn | undefined {
  const capture = CAPTURES.get(target);
  if (capture) return capture.originals[method];
  const current = (target as Partial<ConsoleCaptureTarget>)[method];
  return typeof current === 'function' ? current : undefined;
}

/**
 * Forward `console.warn` and `console.error` (by default) into `logger`. Returns the function
 * that restores the originals. Capturing an already-captured console restores it first, so the
 * last call wins; nested captures are not a thing.
 */
export function captureConsole(
  logger: Logger,
  options: ConsoleCaptureOptions = {},
): RestoreConsole {
  const target: ConsoleCaptureTarget = options.console ?? console;
  CAPTURES.get(target)?.restore();

  const passthrough = options.passthrough ?? true;
  const levels = resolveLevels(options.levels);
  const originals = {} as Record<ConsoleCaptureMethod, ConsoleFn>;
  for (const method of METHODS) {
    const current = target[method];
    originals[method] = typeof current === 'function' ? current : () => {};
  }

  const patched: Partial<Record<ConsoleCaptureMethod, ConsoleFn>> = {};
  const restore: RestoreConsole = () => {
    if (CAPTURES.get(target) !== capture) return;
    for (const method of METHODS) {
      // Only undo our own patch: something that patched after us keeps its method.
      if (patched[method] && target[method] === patched[method]) target[method] = originals[method];
    }
    CAPTURES.delete(target);
  };
  const capture: Capture = { originals, patched, restore };

  for (const method of METHODS) {
    const level = levels[method];
    if (!level) continue;
    const original = originals[method];
    const replacement: ConsoleFn = (...args) => {
      if (forwarding) {
        original.apply(target, args);
        return;
      }
      forwarding = true;
      try {
        const { message, error, context } = mapArguments(method, args);
        if (error === undefined) logger[level](message, context);
        else logger[level](message, error, context);
      } catch {
        // The logger never throws (invariant 3); this guards the mapping itself.
      } finally {
        forwarding = false;
      }
      if (passthrough) original.apply(target, args);
    };
    patched[method] = replacement;
    target[method] = replacement;
  }

  CAPTURES.set(target, capture);
  return restore;
}

function resolveLevels(
  overrides: ConsoleCaptureOptions['levels'],
): Partial<Record<ConsoleCaptureMethod, Level>> {
  if (!overrides) return DEFAULT_LEVELS;
  const levels: Partial<Record<ConsoleCaptureMethod, Level>> = {};
  for (const method of METHODS) {
    const value = overrides[method];
    if (isLevel(value)) levels[method] = value;
  }
  return levels;
}

// ---------------------------------------------------------------------------------------------
// Argument mapping. A leading string is the message, with util.format's common placeholders
// honoured; of what remains, the first error becomes the error, plain objects merge into context
// and any other object lands under `argN` — objects are never stringified into the message, so
// key redaction always sees them. Primitives are appended to the message.

interface Mapped {
  readonly message: string;
  readonly error?: unknown;
  readonly context: LogContext;
}

const PLACEHOLDER = /%[sdifjoO%]/g;

function mapArguments(method: ConsoleCaptureMethod, args: readonly unknown[]): Mapped {
  const rest = [...args];
  const parts: string[] = [];
  const context: Record<string, unknown> = {};
  let error: unknown;
  let extra = 0;

  if (typeof rest[0] === 'string') {
    const template = rest.shift() as string;
    parts.push(
      template.replace(PLACEHOLDER, (token) => {
        if (token === '%%') return '%';
        if (rest.length === 0) return token;
        return interpolate(token, rest.shift());
      }),
    );
  }

  for (const arg of rest) {
    if (error === undefined && isErrorLike(arg)) {
      error = arg;
      continue;
    }
    if (typeof arg === 'object' && arg !== null) {
      if (isPlainObject(arg)) Object.assign(context, arg);
      else context[`arg${extra++}`] = arg;
      continue;
    }
    parts.push(primitiveText(arg));
  }

  let message = parts.join(' ').trim();
  if (message === '') message = `(console.${method})`;
  return { message, error, context };
}

function interpolate(token: string, value: unknown): string {
  switch (token) {
    case '%d':
    case '%f':
      return typeof value === 'bigint' ? `${value}n` : String(Number(value));
    case '%i':
      return String(Math.trunc(Number(value)));
    case '%j':
    case '%o':
    case '%O':
      return jsonText(value);
    default:
      // %s — strings and primitives as they are, objects as JSON so nothing is lost.
      return typeof value === 'object' && value !== null ? jsonText(value) : primitiveText(value);
  }
}

function jsonText(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? primitiveText(value) : text;
  } catch {
    return '[object]';
  }
}

function primitiveText(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'symbol':
      return value.toString();
    case 'function':
      return '[Function]';
    case 'object':
      return value === null ? 'null' : isErrorLike(value) ? errorText(value) : '[object]';
    default:
      return String(value);
  }
}

function errorText(value: { name?: unknown; message: unknown }): string {
  const name = typeof value.name === 'string' && value.name !== '' ? value.name : 'Error';
  return `${name}: ${String(value.message)}`;
}

function isErrorLike(value: unknown): value is { name?: unknown; message: unknown } {
  if (value instanceof Error) return true;
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.message === 'string' &&
    (typeof candidate.name === 'string' || typeof candidate.stack === 'string')
  );
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
