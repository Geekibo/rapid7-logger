import { LEVEL_MONIKERS } from './levels.js';
import type {
  FormatterOptions,
  LineFormatter,
  LogContext,
  LogErrorInfo,
  LogEvent,
} from './types.js';

// LogEvent → the one physical line the endpoint accepts (DESIGN §5.3). Everything here is
// total: a transport may call it unguarded. The two things that are correctness rather than
// style — flattening (§2.2) and the byte cap (§5.4) — are applied unconditionally, including to
// a user-supplied `format` override.

/** Measured 2026-10-08 (§5.4): the endpoint splits anything longer into separate entries. */
export const DEFAULT_MAX_BYTES = 32_767;
/** The marker alone needs ~40 bytes; below this a cap cannot say what it did. */
export const MIN_MAX_BYTES = 128;
export const DEFAULT_CORRELATION_KEY = 'traceId';

const encoder = new TextEncoder();

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Invariant 2: no interior newlines, ever. `\r\n`, a lone `\r` and `\n` each become one space.
 * Measured: the endpoint keeps only the first line of a body containing `\n` or `\r\n` (§2.2).
 */
export function flattenLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ');
}

/**
 * The clickable correlation stamp (§2.5): the id, a colon, a space, a literal underscore and a
 * space. Every character is load-bearing. Rapid7's viewer renders a token as clickable only
 * when it parses as the KEY of a key/value pair — the colon makes the id a key; a bare id is
 * not clickable at all. The underscore is the pair's VALUE: without it, a message carrying its
 * own `Label: value` text chains onto the stamp and the line loses its click. The id is emitted
 * in full; a library must not choose a truncation. Re-measured from Node on 2026-10-08:
 * `where(<id>=_)` matches a line posted in this form.
 */
export function correlationStamp(id: string): string {
  return `${id}: _ `;
}

function formatTime(timestamp: unknown): string {
  // UTC, deliberately: production runs in UTC, Edge runtimes may lack ICU, and a fixed zone
  // keeps tests deterministic. The .NET original used local time; this is a documented
  // divergence (§5.3).
  if (timestamp instanceof Date && !Number.isNaN(timestamp.getTime())) {
    return timestamp.toISOString().slice(11, 19);
  }
  return '--:--:--';
}

function quote(text: string): string {
  return JSON.stringify(text);
}

/** A bare word is scannable and clickable; anything that would break `key=value` parsing is quoted. */
function renderString(text: string): string {
  return text === '' || /[\s="]/.test(text) ? quote(text) : text;
}

function describeError(value: { name?: unknown; message?: unknown }): string {
  const name = typeof value.name === 'string' && value.name !== '' ? value.name : 'Error';
  const message = typeof value.message === 'string' ? value.message : '';
  return message === '' ? name : `${name}: ${message}`;
}

/** Compact JSON with the things JSON.stringify gets wrong for logging fixed. */
function renderJson(value: object): string {
  const ancestors: unknown[] = [];
  return JSON.stringify(value, function replacer(this: unknown, _key: string, current: unknown) {
    // `this` is the holder; trim the ancestor stack back to it so siblings are not "cycles".
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (typeof current === 'bigint') return current.toString();
    if (current instanceof Error) return describeError(current);
    if (typeof current === 'object' && current !== null) {
      if (ancestors.includes(current)) return '[Circular]';
      ancestors.push(current);
    }
    return current;
  });
}

/** Render one context value for a `key=value` pair (§5.3). Never throws. */
export function renderValue(value: unknown): string | undefined {
  try {
    switch (typeof value) {
      case 'undefined':
        return undefined;
      case 'string':
        return renderString(value);
      case 'number':
      case 'boolean':
        return String(value);
      case 'bigint':
        return value.toString();
      case 'symbol':
        return quote(String(value));
      case 'function':
        return '[Function]';
      case 'object': {
        if (value === null) return 'null';
        if (value instanceof Date) {
          return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
        }
        if (value instanceof Error) return quote(describeError(value));
        return renderJson(value) ?? '[unserializable]';
      }
      default:
        return '[unserializable]';
    }
  } catch {
    return '[unserializable]';
  }
}

function renderPairs(context: LogContext, skipKey: string | undefined): string {
  const parts: string[] = [];
  let entries: [string, unknown][];
  try {
    entries = Object.entries(context);
  } catch {
    return 'context=[unserializable]';
  }
  for (const [key, value] of entries) {
    if (key === skipKey) continue;
    const rendered = renderValue(value);
    if (rendered !== undefined) parts.push(`${key}=${rendered}`);
  }
  return parts.join(' ');
}

/**
 * The error goes last (§5.3): the stack is the longest, least structured part of the line, so
 * truncation eats deep frames rather than context keys, and the key/value region stays
 * contiguous. V8 stacks begin with `Name: message`, so the stack alone is emitted then.
 */
function renderError(error: LogErrorInfo): string {
  const head = describeError(error);
  const stack = typeof error.stack === 'string' ? error.stack : '';
  if (stack === '') return head;
  return stack.startsWith(head) ? stack : `${head} ${stack}`;
}

function normaliseMaxBytes(value: number | undefined): number {
  if (value === Infinity) return Infinity;
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) return DEFAULT_MAX_BYTES;
  return Math.max(MIN_MAX_BYTES, Math.floor(value));
}

function marker(removed: string, total: number): string {
  return ` … [truncated ${removed} of ${total} bytes]`;
}

function codePointBytes(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  // A lone surrogate is encoded as U+FFFD (3 bytes) by fetch, so count it that way.
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Defensive truncation (§5.4). The result, marker included, is at most `maxBytes` of UTF-8,
 * cut on a code-point boundary. `N of M` means N bytes were removed from an M-byte line.
 */
export function truncateLine(line: string, maxBytes: number = DEFAULT_MAX_BYTES): string {
  const cap = normaliseMaxBytes(maxBytes);
  if (cap === Infinity) return line;
  // Fast path: a UTF-16 unit is at most 3 UTF-8 bytes, except surrogate pairs (two units → 4).
  if (line.length * 3 <= cap) return line;
  const total = utf8Length(line);
  if (total <= cap) return line;
  // Reserve the marker at its widest: N has at most as many digits as M.
  const widest = marker('9'.repeat(String(total).length), total);
  const budget = Math.max(0, cap - utf8Length(widest));
  let kept = 0;
  let cut = 0;
  for (const ch of line) {
    const size = codePointBytes(ch.codePointAt(0) ?? 0);
    if (kept + size > budget) break;
    kept += size;
    cut += ch.length;
  }
  return line.slice(0, cut) + marker(String(total - kept), total);
}

function messageOf(event: LogEvent): string {
  return typeof event.message === 'string' ? event.message : String(event.message);
}

/** The default line (§5.3). Pure, so a `format` override can compose with it. */
export function formatEvent(event: LogEvent, options: FormatterOptions = {}): string {
  const correlationKey = options.correlationKey ?? DEFAULT_CORRELATION_KEY;
  const line = defaultLine(event, correlationKey);
  return truncateLine(flattenLine(line), options.maxBytes);
}

function defaultLine(event: LogEvent, correlationKey: string): string {
  try {
    const context: LogContext =
      typeof event.context === 'object' && event.context !== null ? event.context : {};
    const id = context[correlationKey];
    const stamped = typeof id === 'string' && id.trim() !== '';
    const parts = [
      `[${formatTime(event.timestamp)} ${LEVEL_MONIKERS[event.level] ?? '???'}] ${stamped ? correlationStamp(id) : ''}${messageOf(event)}`,
    ];
    const pairs = renderPairs(context, stamped ? correlationKey : undefined);
    if (pairs !== '') parts.push(pairs);
    if (event.error && typeof event.error === 'object') {
      if (typeof event.error.digest === 'string')
        parts.push(`digest=${renderString(event.error.digest)}`);
      parts.push(renderError(event.error));
    }
    return parts.join(' ');
  } catch (cause) {
    return `[--:--:-- ???] ${safeMessage(event)} formatError=${quote(describeError(asErrorLike(cause)))}`;
  }
}

function safeMessage(event: LogEvent): string {
  try {
    return messageOf(event);
  } catch {
    return '';
  }
}

function asErrorLike(value: unknown): { name?: unknown; message?: unknown } {
  return typeof value === 'object' && value !== null ? value : { message: String(value) };
}

/** A formatter honouring `format` (§5.3) with fallback. Flattening and the cap are not optional. */
export function createFormatter(options: FormatterOptions = {}): LineFormatter {
  const { format } = options;
  if (!format) return (event) => formatEvent(event, options);
  return (event) => {
    let line: string | undefined;
    let failure: unknown;
    try {
      const produced = format(event);
      if (typeof produced === 'string') line = produced;
      else failure = new TypeError(`format returned ${typeof produced}, not a string`);
    } catch (cause) {
      failure = cause;
    }
    if (line === undefined) {
      line = `${defaultLine(event, options.correlationKey ?? DEFAULT_CORRELATION_KEY)} formatError=${quote(describeError(asErrorLike(failure)))}`;
    }
    return truncateLine(flattenLine(line), options.maxBytes);
  };
}
