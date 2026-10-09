import { describe, expect, it, vi } from 'vitest';
import { MemoryTransport } from '../../src/transports/memory.js';
import type { Logger } from '../../src/core/types.js';
import type { Lifecycle } from '../../src/node/lifecycle.js';
import { createLogger, createNodeLogger } from '../../src/node/logger.js';

function fakeLifecycle() {
  const unregister = vi.fn();
  const register = vi.fn((_logger: Logger, _timeoutMs: number) => unregister);
  const lifecycle: Lifecycle = { register };
  return { lifecycle, register, unregister };
}

describe('the Node createLogger', () => {
  it('registers with the lifecycle by default, with the 2000 ms bound', () => {
    const { lifecycle, register } = fakeLifecycle();
    createNodeLogger({ transport: new MemoryTransport() }, lifecycle);
    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0]?.[1]).toBe(2000);
  });

  it('honours lifecycle.timeoutMs and falls back to the default for junk', () => {
    const { lifecycle, register } = fakeLifecycle();
    createNodeLogger(
      { transport: new MemoryTransport(), lifecycle: { timeoutMs: 500 } },
      lifecycle,
    );
    createNodeLogger({ transport: new MemoryTransport(), lifecycle: { timeoutMs: -1 } }, lifecycle);
    createNodeLogger(
      { transport: new MemoryTransport(), lifecycle: { timeoutMs: NaN } },
      lifecycle,
    );
    expect(register.mock.calls.map((c) => c[1])).toEqual([500, 2000, 2000]);
  });

  it('registers nothing with lifecycle: false', () => {
    const { lifecycle, register } = fakeLifecycle();
    createNodeLogger({ transport: new MemoryTransport(), lifecycle: false }, lifecycle);
    expect(register).not.toHaveBeenCalled();
  });

  it('delegates logging, child, flush and stats to the core logger', async () => {
    const { lifecycle } = fakeLifecycle();
    const transport = new MemoryTransport();
    const log = createNodeLogger({ transport, service: 'svc' }, lifecycle);
    log.info('root');
    log.child({ traceId: 't1' }).warn('child');
    await log.flush(1000);
    expect(transport.events.map((e) => [e.level, e.message, e.context])).toEqual([
      ['info', 'root', { service: 'svc' }],
      ['warn', 'child', { service: 'svc', traceId: 't1' }],
    ]);
    expect(log.stats()).toMatchObject({ sent: 2, failed: 0 });
  });

  it('close() unregisters, flushes, and is idempotent', async () => {
    const { lifecycle, unregister } = fakeLifecycle();
    const transport = new MemoryTransport();
    const log = createNodeLogger({ transport }, lifecycle);
    log.info('before close');
    await log.close(1000);
    await log.close(1000);
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(transport.events).toHaveLength(1);
  });

  it('never throws, even when the registry does', () => {
    const onInternalError = vi.fn();
    const broken: Lifecycle = {
      register: () => {
        throw new Error('no hooks for you');
      },
    };
    const log = createNodeLogger({ transport: new MemoryTransport(), onInternalError }, broken);
    expect(() => log.info('still works')).not.toThrow();
    expect(onInternalError).toHaveBeenCalledOnce();
    expect(String(onInternalError.mock.calls[0]?.[0])).toMatch(/lifecycle hooks not installed/);
  });

  it('the exported createLogger uses the real process: one listener set, removed on close', async () => {
    const before = process.listenerCount('SIGTERM');
    const a = createLogger({ transport: new MemoryTransport() });
    const b = createLogger({ transport: new MemoryTransport() });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    await a.close(100);
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    await b.close(100);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});

describe('the ambient trace provider', () => {
  it('is wired by default and replaced by an explicit contextProvider', async () => {
    const { lifecycle } = fakeLifecycle();
    const a = new MemoryTransport();
    const b = new MemoryTransport();
    const { withTrace } = await import('../../src/node/trace.js');
    const defaults = createNodeLogger({ transport: a }, lifecycle);
    const explicit = createNodeLogger(
      { transport: b, contextProvider: () => ({ k: 'v' }) },
      lifecycle,
    );
    withTrace('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01', () => {
      defaults.info('x');
      explicit.info('y');
    });
    await Promise.all([defaults.flush(1000), explicit.flush(1000)]);
    expect(a.events[0]?.context).toEqual({ traceId: 'a'.repeat(32) });
    expect(b.events[0]?.context).toEqual({ k: 'v' });
  });
});
