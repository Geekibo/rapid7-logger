import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/node/logger.js';
import {
  currentTrace,
  currentTraceId,
  currentTraceparent,
  outboundHeaders,
  withTrace,
} from '../../src/node/trace.js';
import { MemoryTransport } from '../../src/transports/memory.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const HEADER = `00-${TRACE}-${PARENT}-01`;

// A logger created at module scope, as a real application would: no request plumbing at all.
const transport = new MemoryTransport();
const log = createLogger({ transport, lifecycle: false, service: 'svc' });
const moduleChild = log.child({ component: 'db' });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('correlation (§6.4)', () => {
  it('a trace id set at the top of a request reaches a line logged three async frames deep (done when)', async () => {
    transport.clear();
    await withTrace(HEADER, async () => {
      await sleep(1); // frame 1: await
      await new Promise<void>((resolve) => setTimeout(resolve, 1)); // frame 2: timer
      await Promise.resolve().then(() => log.info('deep')); // frame 3: then
      moduleChild.warn('from a module-scope child');
    });
    await log.flush(1000);
    expect(transport.events.map((e) => e.context.traceId)).toEqual([TRACE, TRACE]);
    expect(transport.lines()[0]).toMatch(
      new RegExp(`^\\[\\d\\d:\\d\\d:\\d\\d INF\\] ${TRACE}: _ deep service=svc$`),
    );
    expect(transport.lines()[1]).toContain(`${TRACE}: _ from a module-scope child`);
  });

  it('an explicit header wins and this tier gets its own span; tracestate is kept', () => {
    withTrace(new Headers({ traceparent: HEADER, tracestate: 'a=b' }), () => {
      const trace = currentTrace();
      expect(trace?.traceId).toBe(TRACE);
      expect(trace?.parentId).not.toBe(PARENT);
      expect(trace?.tracestate).toBe('a=b');
      expect(currentTraceparent()).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-01$`));
      expect(outboundHeaders()).toEqual({ traceparent: currentTraceparent(), tracestate: 'a=b' });
    });
  });

  it('generates a trace when there is no usable header, and nests as a child span', () => {
    withTrace(() => {
      const outer = currentTrace();
      expect(outer?.traceId).toMatch(/^[0-9a-f]{32}$/);
      withTrace('garbage', () => {
        expect(currentTraceId()).toBe(outer?.traceId);
        expect(currentTrace()?.parentId).not.toBe(outer?.parentId);
      });
      expect(currentTrace()).toEqual(outer);
    });
  });

  it('is undefined and empty outside a trace', () => {
    expect(currentTrace()).toBeUndefined();
    expect(currentTraceId()).toBeUndefined();
    expect(currentTraceparent()).toBeUndefined();
    expect(outboundHeaders()).toEqual({});
  });

  it('per-call context overrides ambient, which overrides bound', async () => {
    transport.clear();
    const bound = log.child({ traceId: 'bound' });
    withTrace(HEADER, () => {
      bound.info('ambient beats bound');
      bound.info('call beats ambient', { traceId: 'call' });
    });
    bound.info('bound alone');
    await log.flush(1000);
    expect(transport.events.map((e) => e.context.traceId)).toEqual([TRACE, 'call', 'bound']);
  });

  it('interleaved requests never leak into each other', async () => {
    transport.clear();
    const a = `00-${'a'.repeat(32)}-${PARENT}-01`;
    const b = `00-${'b'.repeat(32)}-${PARENT}-01`;
    await Promise.all([
      withTrace(a, async () => {
        log.info('a1');
        await sleep(5);
        log.info('a2');
      }),
      withTrace(b, async () => {
        log.info('b1');
        await sleep(1);
        log.info('b2');
      }),
    ]);
    await log.flush(1000);
    const byMessage = Object.fromEntries(
      transport.events.map((e) => [e.message, e.context.traceId]),
    );
    expect(byMessage).toEqual({
      a1: 'a'.repeat(32),
      a2: 'a'.repeat(32),
      b1: 'b'.repeat(32),
      b2: 'b'.repeat(32),
    });
  });

  it('returns what fn returns and propagates what it throws', async () => {
    expect(withTrace(() => 42)).toBe(42);
    await expect(withTrace(() => Promise.resolve('async'))).resolves.toBe('async');
    expect(() =>
      withTrace(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });

  it('an explicit contextProvider replaces the ambient trace', async () => {
    const custom = new MemoryTransport();
    const custom_log = createLogger({
      transport: custom,
      lifecycle: false,
      contextProvider: () => ({ tenant: 't1' }),
    });
    withTrace(HEADER, () => custom_log.info('x'));
    await custom_log.flush(1000);
    expect(custom.events[0]?.context).toEqual({ tenant: 't1' });
  });
});
