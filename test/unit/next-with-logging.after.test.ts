/* eslint-disable @typescript-eslint/require-await -- async fns without await model Server Actions */
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/core/logger.js';
import type { Logger } from '../../src/core/types.js';
import { loadAfter, resolvedAfter, withLogging } from '../../src/next/with-logging.js';
import { MemoryTransport } from '../../src/transports/memory.js';

// `next` is not installed; vi.mock virtualises `next/server` so the default path — the dynamic
// import — can be exercised. One mock per file, hence the separate file.
const tasks: (() => Promise<void> | void)[] = [];
vi.mock('next/server', () => ({
  after: (task: () => Promise<void> | void) => {
    tasks.push(task);
  },
}));

describe('withLogging with next/server present', () => {
  it('schedules the flush through the real after() by default', async () => {
    await loadAfter();
    expect(typeof resolvedAfter()).toBe('function');
    const flush = vi.fn((_t?: number) => Promise.resolve());
    const base = createLogger({ transport: new MemoryTransport() });
    const log: Logger = {
      trace: base.trace,
      debug: base.debug,
      info: base.info,
      warn: base.warn,
      error: base.error,
      fatal: base.fatal,
      child: () => ({ ...log }),
      flush,
      stats: () => base.stats(),
    };
    await withLogging(log, 'op', async () => 'ok')();
    expect(flush).not.toHaveBeenCalled(); // after() holds the task until the response is sent
    expect(tasks).toHaveLength(1);
    await tasks[0]!();
    expect(flush).toHaveBeenCalledExactlyOnceWith(1500);
  });
});
