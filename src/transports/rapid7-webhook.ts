import { resolveConfig } from '../core/config.js';
import { createFormatter } from '../core/formatter.js';
import type {
  FormatterOptions,
  LineFormatter,
  LogEvent,
  Region,
  SendOutcome,
  Transport,
} from '../core/types.js';

// The real transport (DESIGN §2.1, §2.3, §7.1): one HTTP request per event over the runtime's
// `fetch`, a port of the proven .NET implementation, with its retry policy. Only `fetch`,
// `AbortController` and timers are used, so it runs on Edge (invariant 8).
//
// Measured 2026-10-08 (Node 20.20 / undici 6.23): Node's global fetch pools connections by
// default, so there is nothing to configure for keep-alive (§2.3); an undrained error body
// costs a new socket per request, so responses are always drained with `text()`.

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS = 200;
/** A server asking for a longer pause than this is honoured only this far (§7.1). */
export const DEFAULT_RETRY_AFTER_CAP_MS = 30_000;
const USER_AGENT = '@geekibo/rapid7-logger';

export interface Rapid7WebhookTransportOptions extends FormatterOptions {
  /** The log's ingestion token (a GUID). A write credential — never logged. */
  readonly token: string;
  /** `eu` (default) | `us` | `au` | `ca` | `jp`. */
  readonly region?: Region | (string & {});
  /** Defaults to the global `fetch`, resolved at send time. */
  readonly fetch?: typeof fetch;
  /** Per-attempt timeout. Default 10,000 ms. */
  readonly timeoutMs?: number;
  /** Attempts per event, on `5xx`, `408`, `429` and network failures (§7.1). Default 3. */
  readonly maxAttempts?: number;
  /** Wait before attempt n is `backoffMs × (n − 1)`. Default 200 ms. */
  readonly backoffMs?: number;
  /** Cap on an honoured `Retry-After`. Default 30,000 ms. */
  readonly retryAfterCapMs?: number;
}

function positive(value: number | undefined, fallback: number, minimum = 1): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : fallback;
}

/** §7.1: transient statuses are retried; any other 4xx will not become good. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * `Retry-After` as a delay in ms: integer seconds, or an HTTP-date. `undefined` when absent or
 * unparseable, so the caller falls back to the fixed backoff.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^-?\d+$/.test(value)) {
    const seconds = Number(value);
    return seconds < 0 ? undefined : seconds * 1000;
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Attempt =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: string;
      readonly retry: boolean;
      readonly retryAfterMs?: number;
    };

function causeCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Posts each event as its own request to `/v1/noformat/{token}` (§2.1).
 *
 * `delivered: true` means the endpoint *accepted* the line. Measured (§2.6): a well-formed but
 * wrong token, or the wrong region, is also accepted with `204` and silently discarded, so
 * acceptance is not proof of arrival.
 */
export class Rapid7WebhookTransport implements Transport {
  // ES private fields, not TS `private`: the token is a write credential and a TS-private
  // property is still enumerable, so `JSON.stringify(transport)` would print it (invariant 9).
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: typeof fetch | undefined;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #backoffMs: number;
  readonly #retryAfterCapMs: number;
  readonly #format: LineFormatter;

  /** @throws TypeError when the token is not a GUID or the region is unknown. */
  constructor(options: Rapid7WebhookTransportOptions) {
    const config = resolveConfig(options.token, options.region);
    if (!config.ok) throw new TypeError(`Rapid7WebhookTransport: ${config.problem}`);
    this.#token = config.token;
    this.#url = `https://${config.region}.webhook.logs.insight.rapid7.com/v1/noformat/${config.token}`;
    this.#fetch = options.fetch;
    this.#timeoutMs = positive(options.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.#maxAttempts = Math.floor(positive(options.maxAttempts, DEFAULT_MAX_ATTEMPTS));
    this.#backoffMs = positive(options.backoffMs, DEFAULT_BACKOFF_MS, 0);
    this.#retryAfterCapMs = positive(options.retryAfterCapMs, DEFAULT_RETRY_AFTER_CAP_MS, 0);
    this.#format = createFormatter(options);
  }

  /** Nothing reported may carry the token (invariant 9). */
  #scrub(text: string): string {
    return text.replaceAll(this.#token, '<token>');
  }

  /**
   * At-least-once (§7.1): up to `maxAttempts`, backing off `backoffMs × attempt`, honouring a
   * `Retry-After` when present. The endpoint has no dedup, so an ingested POST whose
   * acknowledgement is lost is retried and produces a duplicate — the right trade.
   */
  async send(event: LogEvent): Promise<SendOutcome> {
    // The formatter already flattened and capped the line (§5.3, §5.4); the trailing newline is
    // the body terminator and sits outside the endpoint's cap (measured).
    const body = `${this.#format(event)}\n`;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const result = await this.#attempt(body);
      const retries = attempt - 1;
      if (result.ok) return { delivered: true, retries };
      if (!result.retry || attempt >= this.#maxAttempts) {
        return { delivered: false, retries, error: result.error };
      }
      const delay =
        result.retryAfterMs === undefined
          ? this.#backoffMs * attempt
          : Math.min(result.retryAfterMs, this.#retryAfterCapMs);
      await sleep(delay);
    }
  }

  /** One request. Never throws: every failure comes back classified. */
  async #attempt(body: string): Promise<Attempt> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    try {
      const doFetch = this.#fetch ?? globalThis.fetch;
      if (typeof doFetch !== 'function') {
        return { ok: false, retry: false, error: 'fetch is not available in this runtime' };
      }
      const response = await doFetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'user-agent': USER_AGENT },
        body,
        signal: controller.signal,
      });
      const status = response.status;
      const retryAfterMs =
        status === 429 || status === 503 ? this.#retryAfter(response) : undefined;
      // Drain so the connection can be reused (measured: an undrained body costs a socket).
      try {
        await response.text();
      } catch {
        // The status is what matters; a body that will not read is not a delivery failure.
      }
      if (status >= 200 && status < 300) return { ok: true };
      return { ok: false, retry: isRetryableStatus(status), error: `HTTP ${status}`, retryAfterMs };
    } catch (error) {
      // A timeout or network failure is transient (§7.1); retry within the attempt budget.
      if (timedOut) return { ok: false, retry: true, error: `timeout after ${this.#timeoutMs}ms` };
      return { ok: false, retry: true, error: this.#scrub(causeCode(error) ?? describe(error)) };
    } finally {
      // Every attempt would otherwise leave a live timer that keeps a Node process alive.
      clearTimeout(timer);
    }
  }

  #retryAfter(response: Response): number | undefined {
    try {
      return parseRetryAfter(response.headers.get('retry-after'));
    } catch {
      return undefined;
    }
  }

  /** Nothing is buffered here: the queue (§7.2) awaits in-flight sends before calling this. */
  flush(_timeoutMs?: number): Promise<void> {
    return Promise.resolve();
  }
}
