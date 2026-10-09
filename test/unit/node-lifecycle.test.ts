import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger, LoggerStats } from '../../src/core/types.js';
import { createLifecycle, OWNER_TAG, type ProcessLike } from '../../src/node/lifecycle.js';

/** A process stand-in: a real EventEmitter plus a kill spy. Never the real process. */
function fakeProcess() {
  const emitter = new EventEmitter();
  const kill = vi.fn();
  const proc: ProcessLike = {
    pid: 4242,
    on: (event, listener) => emitter.on(event, listener),
    removeListener: (event, listener) => emitter.removeListener(event, listener),
    listeners: (event) => emitter.listeners(event),
    kill,
  };
  return { proc, emitter, kill };
}

/** A logger whose flush resolves on demand (or after `delayMs` under fake timers). */
function fakeLogger(options: { queued?: number; delayMs?: number; reject?: boolean } = {}) {
  const flush = vi.fn((timeoutMs?: number) => {
    if (options.reject) return Promise.reject(new Error('flush broke'));
    const delay = Math.min(options.delayMs ?? 0, timeoutMs ?? Infinity);
    if (delay === 0) return Promise.resolve();
    return new Promise<void>((resolve) => setTimeout(resolve, delay));
  });
  const stats = (): LoggerStats => ({
    queued: options.queued ?? 0,
    sent: 0,
    dropped: 0,
    failed: 0,
    retried: 0,
  });
  const noop = () => {};
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
    flush,
    stats,
  };
  return { logger, flush };
}

const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => vi.useRealTimers());

describe('registration', () => {
  it('installs one listener per event however many loggers register, and removes them on the last unregister', () => {
    const { proc, emitter } = fakeProcess();
    const lifecycle = createLifecycle(proc);
    expect(emitter.listenerCount('SIGTERM')).toBe(0);
    const unregisters = Array.from({ length: 20 }, () =>
      lifecycle.register(fakeLogger().logger, 100),
    );
    for (const event of ['SIGTERM', 'SIGINT', 'beforeExit']) {
      expect(emitter.listenerCount(event)).toBe(1);
      expect((emitter.listeners(event)[0] as unknown as Record<symbol, unknown>)[OWNER_TAG]).toBe(
        true,
      );
    }
    unregisters.slice(0, 19).forEach((u) => u());
    expect(emitter.listenerCount('SIGTERM')).toBe(1);
    unregisters[19]!();
    unregisters[19]!(); // idempotent
    for (const event of ['SIGTERM', 'SIGINT', 'beforeExit']) {
      expect(emitter.listenerCount(event)).toBe(0);
    }
  });
});

describe('beforeExit', () => {
  it('returns synchronously when nothing is queued, and flushes when something is', () => {
    const { proc, emitter } = fakeProcess();
    const lifecycle = createLifecycle(proc);
    const idle = fakeLogger({ queued: 0 });
    const busy = fakeLogger({ queued: 3 });
    lifecycle.register(idle.logger, 100);
    lifecycle.register(busy.logger, 250);
    emitter.emit('beforeExit', 0);
    expect(idle.flush).not.toHaveBeenCalled();
    expect(busy.flush).toHaveBeenCalledWith(250);
  });
});

describe('signals', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)(
    'as the sole %s listener: flushes, then removes itself and re-raises — not before the flush resolves',
    async (signal) => {
      vi.useFakeTimers();
      const { proc, emitter, kill } = fakeProcess();
      const lifecycle = createLifecycle(proc);
      const a = fakeLogger({ delayMs: 100 });
      const b = fakeLogger({ delayMs: 50 });
      lifecycle.register(a.logger, 1000);
      lifecycle.register(b.logger, 1000);
      emitter.emit(signal);
      expect(a.flush).toHaveBeenCalledWith(1000);
      expect(b.flush).toHaveBeenCalledWith(1000);
      await vi.advanceTimersByTimeAsync(99);
      expect(kill).not.toHaveBeenCalled();
      expect(emitter.listenerCount(signal)).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await tick();
      expect(emitter.listenerCount(signal)).toBe(0);
      expect(kill).toHaveBeenCalledExactlyOnceWith(4242, signal);
    },
  );

  it('with an application handler present: flushes, never re-raises, stays installed', async () => {
    const { proc, emitter, kill } = fakeProcess();
    const lifecycle = createLifecycle(proc);
    const app = vi.fn();
    emitter.on('SIGTERM', app);
    const { logger, flush } = fakeLogger();
    lifecycle.register(logger, 100);
    emitter.emit('SIGTERM');
    await tick();
    expect(app).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
    expect(emitter.listenerCount('SIGTERM')).toBe(2);
  });

  it('is bounded: a logger whose flush honours its timeout lets the re-raise happen at the bound', async () => {
    vi.useFakeTimers();
    const { proc, emitter, kill } = fakeProcess();
    const lifecycle = createLifecycle(proc);
    lifecycle.register(fakeLogger({ delayMs: 60_000 }).logger, 100);
    emitter.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(99);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await tick();
    expect(kill).toHaveBeenCalledOnce();
  });

  it('a second signal during a flush re-raises immediately', async () => {
    vi.useFakeTimers();
    const { proc, emitter, kill } = fakeProcess();
    const lifecycle = createLifecycle(proc);
    lifecycle.register(fakeLogger({ delayMs: 5000 }).logger, 10_000);
    emitter.emit('SIGINT');
    await tick();
    expect(kill).not.toHaveBeenCalled();
    emitter.emit('SIGINT');
    expect(kill).toHaveBeenCalledExactlyOnceWith(4242, 'SIGINT');
  });

  it('two registries on one process (the dual ESM/CJS case) re-raise exactly once', async () => {
    const { proc, emitter, kill } = fakeProcess();
    const one = createLifecycle(proc);
    const two = createLifecycle(proc);
    one.register(fakeLogger().logger, 100);
    two.register(fakeLogger().logger, 100);
    expect(emitter.listenerCount('SIGTERM')).toBe(2);
    emitter.emit('SIGTERM');
    await tick();
    expect(emitter.listenerCount('SIGTERM')).toBe(0);
    expect(kill).toHaveBeenCalledOnce();
  });

  it('a logger whose flush rejects or stats throw never breaks the hook', async () => {
    const { proc, emitter, kill } = fakeProcess();
    const lifecycle = createLifecycle(proc);
    const hostile = fakeLogger({ reject: true });
    hostile.logger.stats = () => {
      throw new Error('stats broke');
    };
    lifecycle.register(hostile.logger, 100);
    expect(() => emitter.emit('beforeExit', 0)).not.toThrow();
    expect(() => emitter.emit('SIGTERM')).not.toThrow();
    await tick();
    expect(kill).toHaveBeenCalledOnce();
  });
});
