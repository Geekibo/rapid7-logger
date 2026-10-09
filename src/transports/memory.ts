import { createFormatter } from '../core/formatter.js';
import type { FormatterOptions, LineFormatter, LogEvent, Transport } from '../core/types.js';

// Captures events for assertions (§4.1): the backbone of the unit suite, and useful in a
// consumer's own tests via `createLogger({ transport: new MemoryTransport() })`. Unbounded by
// design — it is test infrastructure, not a production sink.

export type MemoryTransportOptions = FormatterOptions;

export class MemoryTransport implements Transport {
  /** Every event received, in order, exactly as the queue handed it over (already redacted). */
  readonly events: LogEvent[] = [];
  private readonly format: LineFormatter;

  constructor(options: MemoryTransportOptions = {}) {
    this.format = createFormatter(options);
  }

  send(event: LogEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }

  flush(_timeoutMs?: number): Promise<void> {
    return Promise.resolve();
  }

  /** The events rendered as the lines the webhook would post. */
  lines(): string[] {
    return this.events.map((event) => this.format(event));
  }

  clear(): void {
    this.events.length = 0;
  }
}
