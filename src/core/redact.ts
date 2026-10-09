import type { LogContext, LogErrorInfo, LogEvent, RedactOptions } from './types.js';

// Redaction (DESIGN §6.6): runs in the logger before an event reaches the queue, a transport,
// a `format` override or the console fallback, so nothing unredacted leaves the process
// (invariant 9). It is on by default, total (never throws), fail-closed (anything it cannot
// walk is replaced, never passed through), cycle-safe and bounded.

/** A function from one event to a redacted copy. The input is never mutated. */
export type Redactor = (event: LogEvent) => LogEvent;

/**
 * Matched case-insensitively as a substring of the key with `-`, `_` and whitespace removed, so
 * `dbPassword`, `refresh_token`, `x-api-key`, `set-cookie` and `clientSecret` all match.
 * Documented false positives: `tokenCount`, `maxTokens`. Deliberately absent: `auth` (hits
 * `author`), `session`, bare `key`, and PII terms — supply those with `redact.keys`.
 */
export const DEFAULT_REDACT_KEYS: readonly string[] = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apiKey',
  'authorization',
  'cookie',
  'credential',
  'privateKey',
];

/**
 * Applied to every string in the event: the message, every context string, and the error's
 * fields (a stack can embed a URL carrying a token). All linear-time.
 */
export const DEFAULT_REDACT_PATTERNS: readonly RegExp[] = [
  // `Bearer <token>` / `Basic <credentials>`; the scheme is kept so the line still reads.
  /(?<=\b(?:Bearer|Basic)\s+)[A-Za-z0-9\-._~+/]+=*/g,
  // A bare JWT: three base64url segments, the first always decoding from `{"`.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

export const DEFAULT_REPLACEMENT = '[redacted]';
export const MAX_DEPTH = 16;
export const MAX_NODES = 10_000;

const CIRCULAR = '[Circular]';
const MAX_DEPTH_MARKER = '[MaxDepth]';
const MAX_NODES_MARKER = '[MaxNodes]';
const UNSERIALIZABLE = '[unserializable]';
const FUNCTION = '[Function]';

interface Compiled {
  readonly keys: readonly string[];
  readonly patterns: readonly RegExp[];
  readonly replacement: string;
}

export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

function compile(options: RedactOptions): Compiled {
  const useDefaults = options.defaults !== false;
  const keys = [
    ...(useDefaults ? DEFAULT_REDACT_KEYS : []),
    ...(Array.isArray(options.keys) ? options.keys : []).filter(
      (k): k is string => typeof k === 'string',
    ),
  ]
    .map(normaliseKey)
    .filter((k) => k !== '');
  const patterns = [
    ...(useDefaults ? DEFAULT_REDACT_PATTERNS : []),
    ...(Array.isArray(options.patterns) ? options.patterns : []).filter(
      (p): p is RegExp => p instanceof RegExp,
    ),
  ].map((p) => (p.global ? p : new RegExp(p.source, `${p.flags}g`)));
  const replacement =
    typeof options.replacement === 'string' ? options.replacement : DEFAULT_REPLACEMENT;
  return { keys, patterns, replacement };
}

class Walker {
  private nodes = 0;
  private readonly ancestors: object[] = [];

  constructor(private readonly compiled: Compiled) {}

  keyMatches(key: string): boolean {
    const normalised = normaliseKey(key);
    return this.compiled.keys.some((k) => normalised.includes(k));
  }

  string(text: string): string {
    let out = text;
    for (const pattern of this.compiled.patterns) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, this.compiled.replacement);
    }
    return out;
  }

  value(input: unknown, depth: number): unknown {
    try {
      return this.unguarded(input, depth);
    } catch {
      return UNSERIALIZABLE;
    }
  }

  private unguarded(input: unknown, depth: number): unknown {
    if (this.nodes >= MAX_NODES) return MAX_NODES_MARKER;
    this.nodes += 1;
    switch (typeof input) {
      case 'string':
        return this.string(input);
      case 'function':
        return FUNCTION;
      case 'object':
        break;
      default:
        return input;
    }
    if (input === null) return null;
    if (input instanceof Date) return input;
    if (depth >= MAX_DEPTH) return MAX_DEPTH_MARKER;
    if (this.ancestors.includes(input)) return CIRCULAR;

    // An own or inherited toJSON would otherwise run inside the formatter's JSON.stringify,
    // after redaction. Materialise it here and walk what it produces instead.
    const toJSON = (input as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function' && !(input instanceof Error)) {
      this.ancestors.push(input);
      try {
        return this.value(toJSON.call(input), depth + 1);
      } finally {
        this.ancestors.pop();
      }
    }

    this.ancestors.push(input);
    try {
      if (Array.isArray(input)) return input.map((item) => this.value(item, depth + 1));
      if (input instanceof Set) return [...input].map((item) => this.value(item, depth + 1));
      if (input instanceof Map) return this.record([...input.entries()], depth);
      if (input instanceof Error) return this.error(input, depth);
      return this.object(input, depth);
    } finally {
      this.ancestors.pop();
    }
  }

  /** Reads each property inside the guard, so one throwing getter costs one value, not the object. */
  private object(input: object, depth: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      if (this.keyMatches(key)) {
        out[key] = this.compiled.replacement;
        continue;
      }
      let value: unknown;
      try {
        value = (input as Record<string, unknown>)[key];
      } catch {
        out[key] = UNSERIALIZABLE;
        continue;
      }
      out[key] = this.value(value, depth + 1);
    }
    return out;
  }

  private record(entries: Iterable<[unknown, unknown]>, depth: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [rawKey, value] of entries) {
      const key = typeof rawKey === 'string' ? rawKey : String(rawKey);
      out[key] = this.keyMatches(key) ? this.compiled.replacement : this.value(value, depth + 1);
    }
    return out;
  }

  /**
   * An Error in context keeps its shape — the formatter renders it as `"Name: message"` — but
   * with its fields redacted (non-enumerable, as on a real Error) and its own enumerable
   * properties walked like any object.
   */
  private error(input: Error, depth: number): Error {
    const out = new Error(this.string(String(input.message)));
    Object.defineProperty(out, 'name', {
      value: this.string(String(input.name)),
      enumerable: false,
    });
    Object.defineProperty(out, 'stack', {
      value: typeof input.stack === 'string' ? this.string(input.stack) : undefined,
      enumerable: false,
    });
    Object.assign(out, this.object(input, depth));
    return out;
  }
}

function redactErrorInfo(walker: Walker, error: LogErrorInfo): LogErrorInfo {
  const out: { -readonly [K in keyof LogErrorInfo]: LogErrorInfo[K] } = {
    name: walker.string(String(error.name)),
    message: walker.string(String(error.message)),
  };
  if (typeof error.stack === 'string') out.stack = walker.string(error.stack);
  if (typeof error.digest === 'string') out.digest = walker.string(error.digest);
  return out;
}

/** Build a redactor (§6.6). Keys and patterns extend the defaults unless `defaults: false`. */
export function createRedactor(options: RedactOptions = {}): Redactor {
  const compiled = compile(options);
  return (event) => {
    try {
      const walker = new Walker(compiled);
      const context = walker.value(event.context ?? {}, 0);
      const redacted: { -readonly [K in keyof LogEvent]: LogEvent[K] } = {
        timestamp: event.timestamp,
        level: event.level,
        message: walker.string(String(event.message)),
        context: (typeof context === 'object' && context !== null && !Array.isArray(context)
          ? context
          : { context }) as LogContext,
      };
      if (event.error) redacted.error = redactErrorInfo(walker, event.error);
      return redacted;
    } catch (cause) {
      // Fail closed: nothing from the original event passes through.
      return {
        timestamp: event.timestamp,
        level: event.level,
        message: '[redaction failed]',
        context: { redactError: cause instanceof Error ? cause.message : String(cause) },
      };
    }
  };
}
