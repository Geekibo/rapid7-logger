import { createFormatter } from '../core/formatter.js';
import type { FormatterOptions, Level, LineFormatter, LogEvent, Transport } from '../core/types.js';

// The fallback when there is no usable token (§5.1), and the local-development transport. It
// prints exactly the line the webhook transport would post — flattened, stamped, capped — so
// what you see locally is what Rapid7 would store.

type ConsoleMethod = 'debug' | 'info' | 'warn' | 'error';

/** The subset of `console` this transport uses; injectable for tests. */
export type ConsoleLike = Pick<Console, ConsoleMethod>;

export interface ConsoleTransportOptions extends FormatterOptions {
  readonly console?: ConsoleLike;
}

const METHOD: Readonly<Record<Level, ConsoleMethod>> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
};

export class ConsoleTransport implements Transport {
  private readonly format: LineFormatter;
  private readonly target: ConsoleLike;

  constructor(options: ConsoleTransportOptions = {}) {
    this.format = createFormatter(options);
    this.target = options.console ?? console;
  }

  send(event: LogEvent): Promise<void> {
    try {
      this.target[METHOD[event.level] ?? 'info'](this.format(event));
    } catch {
      // A broken console must not take the application down (invariant 3).
    }
    return Promise.resolve();
  }

  flush(_timeoutMs?: number): Promise<void> {
    return Promise.resolve();
  }
}
