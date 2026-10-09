import { LEVEL_MONIKERS } from '../core/levels.js';
import type { Level, LogEvent, Transport } from '../core/types.js';

// The fallback when there is no usable token (§5.1), and the local-dev transport. Minimal in
// #6: #10 completes it (formatter-based rendering, contract run, export).

type ConsoleMethod = 'debug' | 'info' | 'warn' | 'error';

const METHOD: Readonly<Record<Level, ConsoleMethod>> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
};

export class ConsoleTransport implements Transport {
  send(event: LogEvent): Promise<void> {
    try {
      const time = event.timestamp.toISOString().slice(11, 19);
      const prefix = `[${time} ${LEVEL_MONIKERS[event.level]}] ${event.message}`;
      const extra: unknown[] = [];
      if (Object.keys(event.context).length > 0) extra.push(event.context);
      if (event.error) extra.push(event.error);
      console[METHOD[event.level]](prefix, ...extra);
    } catch {
      // A broken console must not take the application down (invariant 3).
    }
    return Promise.resolve();
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}
