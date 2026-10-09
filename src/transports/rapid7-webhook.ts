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
// `fetch`, a port of the proven .NET implementation. Single attempt here; the retry policy is
// #12's. Only `fetch`, `AbortController` and timers are used, so it runs on Edge (invariant 8).
//
// Measured 2026-10-08 (Node 20.20 / undici 6.23): Node's global fetch pools connections by
// default, so there is nothing to configure for keep-alive (§2.3); an undrained error body
// costs a new socket per request, so responses are always drained with `text()`.

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = '@geekibo/rapid7-logger';

export interface Rapid7WebhookTransportOptions extends FormatterOptions {
  /** The log's ingestion token (a GUID). A write credential — never logged. */
  readonly token: string;
  /** `eu` (default) | `us` | `au` | `ca` | `jp`. */
  readonly region?: Region | (string & {});
  /** Defaults to the global `fetch`, resolved at send time. */
  readonly fetch?: typeof fetch;
  /** Per-request timeout. Default 10,000 ms. */
  readonly timeoutMs?: number;
}

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
  readonly #format: LineFormatter;

  /** @throws TypeError when the token is not a GUID or the region is unknown. */
  constructor(options: Rapid7WebhookTransportOptions) {
    const config = resolveConfig(options.token, options.region);
    if (!config.ok) throw new TypeError(`Rapid7WebhookTransport: ${config.problem}`);
    this.#token = config.token;
    this.#url = `https://${config.region}.webhook.logs.insight.rapid7.com/v1/noformat/${config.token}`;
    this.#fetch = options.fetch;
    this.#timeoutMs =
      typeof options.timeoutMs === 'number' && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_REQUEST_TIMEOUT_MS;
    this.#format = createFormatter(options);
  }

  /** Nothing reported may carry the token (invariant 9). */
  #scrub(text: string): string {
    return text.replaceAll(this.#token, '<token>');
  }

  async send(event: LogEvent): Promise<SendOutcome> {
    // The formatter already flattened and capped the line (§5.3, §5.4); the trailing newline is
    // the body terminator and sits outside the endpoint's cap (measured).
    const body = `${this.#format(event)}\n`;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    try {
      const doFetch = this.#fetch ?? globalThis.fetch;
      if (typeof doFetch !== 'function') {
        return { delivered: false, error: 'fetch is not available in this runtime' };
      }
      const response = await doFetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'user-agent': USER_AGENT },
        body,
        signal: controller.signal,
      });
      const status = response.status;
      // Drain so the connection can be reused (measured: an undrained body costs a socket).
      try {
        await response.text();
      } catch {
        // The status is what matters; a body that will not read is not a delivery failure.
      }
      if (status >= 200 && status < 300) return { delivered: true };
      return { delivered: false, error: `HTTP ${status}` };
    } catch (error) {
      if (timedOut) return { delivered: false, error: `timeout after ${this.#timeoutMs}ms` };
      return { delivered: false, error: this.#scrub(causeCode(error) ?? describe(error)) };
    } finally {
      // Every send would otherwise leave a live timer that keeps a Node process alive.
      clearTimeout(timer);
    }
  }

  /** Nothing is buffered here: the queue (§7.2) awaits in-flight sends before calling this. */
  flush(_timeoutMs?: number): Promise<void> {
    return Promise.resolve();
  }
}
