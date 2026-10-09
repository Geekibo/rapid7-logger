import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createLogger } from '../../src/core/logger.js';
import type { Logger } from '../../src/core/types.js';
import {
  createRequestErrorHandler,
  type RequestErrorContext,
  type RequestErrorHandler,
  type RequestErrorRequest,
} from '../../src/next/request-error.js';
import { MemoryTransport } from '../../src/transports/memory.js';

// Verbatim copies of the shipped Next types (next@16.4.0 and next@15.0.0,
// dist/server/instrumentation/types.d.ts), so assignability is checked by `npm run typecheck`
// without installing Next.
type Next16RequestErrorContext = {
  routerKind: 'Pages Router' | 'App Router';
  routePath: string;
  routeType: 'render' | 'route' | 'action' | 'proxy';
  renderSource?: 'react-server-components' | 'react-server-components-payload' | 'server-rendering';
  revalidateReason: 'on-demand' | 'stale' | undefined;
};
type Next16OnRequestError = (
  error: unknown,
  errorRequest: Readonly<{
    path: string;
    method: string;
    headers: Record<string, string | string[] | undefined>;
  }>,
  errorContext: Readonly<Next16RequestErrorContext>,
) => void | Promise<void>;
type Next15OnRequestError = (
  error: unknown,
  errorRequest: Readonly<{
    path: string;
    method: string;
    headers: Record<string, string | string[] | undefined>;
  }>,
  errorContext: Readonly<
    Omit<Next16RequestErrorContext, 'routeType'> & {
      routeType: 'render' | 'route' | 'action' | 'middleware';
    }
  >,
) => void | Promise<void>;

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const request = (
  headers: Record<string, string | string[] | undefined> = {},
): RequestErrorRequest => ({
  path: '/surveys/42',
  method: 'POST',
  headers: { host: 'app', ...headers },
});
const context = (
  routeType: string,
  extra: Partial<RequestErrorContext> = {},
): RequestErrorContext => ({
  routerKind: 'App Router',
  routePath: '/surveys/[id]',
  routeType,
  revalidateReason: undefined,
  ...extra,
});

function setup(options?: Parameters<typeof createRequestErrorHandler>[1]) {
  const transport = new MemoryTransport();
  const log = createLogger({ transport });
  return { transport, handler: createRequestErrorHandler(log, options) };
}

afterEach(() => vi.useRealTimers());

describe('createRequestErrorHandler (§6.1)', () => {
  it('is assignable to Next 16 and Next 15 onRequestError', () => {
    const handler = setup().handler;
    expectTypeOf(handler).toMatchTypeOf<RequestErrorHandler>();
    const sixteen: Next16OnRequestError = handler;
    const fifteen: Next15OnRequestError = handler;
    expect(sixteen).toBe(handler);
    expect(fifteen).toBe(handler);
  });

  it.each(['render', 'route', 'action', 'proxy', 'middleware'])(
    'logs one error line with the digest and route for routeType %s',
    async (routeType) => {
      const { transport, handler } = setup();
      const err = Object.assign(new Error('boom'), { digest: 'abc123' });
      await handler(err, request(), context(routeType));
      expect(transport.events).toHaveLength(1);
      const [event] = transport.events;
      expect(event?.level).toBe('error');
      expect(event?.message).toBe('Unhandled server error');
      expect(event?.error).toMatchObject({ name: 'Error', message: 'boom', digest: 'abc123' });
      expect(event?.context).toEqual({
        path: '/surveys/42',
        method: 'POST',
        routePath: '/surveys/[id]',
        routeType,
        routerKind: 'App Router',
      });
      const line = transport.lines()[0] ?? '';
      expect(line).toContain('digest=abc123');
      expect(line).toContain(`routeType=${routeType}`);
      expect(line).toContain('path=/surveys/42 method=POST routePath=/surveys/[id]');
      expect(line).toContain('routerKind="App Router"');
      expect(line).toMatch(/Error: boom/);
    },
  );

  it('narrows a non-Error: primitives have no digest; objects keep theirs', async () => {
    const { transport, handler } = setup();
    await handler('just a string', request(), context('render'));
    await handler(null, request(), context('render'));
    await handler({ digest: 'd1', weird: true }, request(), context('render'));
    await handler(
      { name: 'HttpError', message: 'nope', digest: 'd2' },
      request(),
      context('route'),
    );
    const [a, b, c, d] = transport.events;
    expect(a?.error).toEqual({ name: 'Error', message: 'just a string' });
    expect(b?.error).toEqual({ name: 'Error', message: 'null' });
    expect(c?.error).toEqual({
      name: 'Error',
      message: '{"digest":"d1","weird":true}',
      digest: 'd1',
    });
    expect(d?.error).toEqual({ name: 'HttpError', message: 'nope', digest: 'd2' });
    expect(transport.lines()[2]).toContain('digest=d1');
  });

  it('copies the optional context fields only when they are strings', async () => {
    const { transport, handler } = setup();
    await handler(
      new Error('x'),
      request(),
      context('render', {
        renderSource: 'server-rendering',
        revalidateReason: 'stale',
        renderType: 'dynamic',
      }),
    );
    expect(transport.events[0]?.context).toMatchObject({
      renderSource: 'server-rendering',
      revalidateReason: 'stale',
      renderType: 'dynamic',
    });
  });

  it('stamps the trace id from an inbound traceparent header, on Edge too', async () => {
    const { transport, handler } = setup();
    await handler(
      new Error('x'),
      request({ traceparent: `00-${TRACE}-00f067aa0ba902b7-01` }),
      context('action'),
    );
    await handler(
      new Error('x'),
      request({ TraceParent: [`00-${TRACE}-00f067aa0ba902b7-01`] }),
      context('action'),
    );
    await handler(new Error('x'), request({ traceparent: 'garbage' }), context('action'));
    expect(transport.events[0]?.context.traceId).toBe(TRACE);
    expect(transport.events[1]?.context.traceId).toBe(TRACE);
    expect(transport.events[2]?.context).not.toHaveProperty('traceId');
    expect(transport.lines()[0]).toMatch(
      new RegExp(`^\\[\\d\\d:\\d\\d:\\d\\d ERR\\] ${TRACE}: _ Unhandled server error`),
    );
  });

  it('a header beats an ambient trace id; no header leaves it', async () => {
    const transport = new MemoryTransport();
    const log = createLogger({ transport, contextProvider: () => ({ traceId: 'ambient' }) });
    const handler = createRequestErrorHandler(log);
    await handler(
      new Error('x'),
      request({ traceparent: `00-${TRACE}-00f067aa0ba902b7-01` }),
      context('render'),
    );
    await handler(new Error('x'), request(), context('render'));
    expect(transport.events.map((e) => e.context.traceId)).toEqual([TRACE, 'ambient']);
  });

  it('awaits a bounded flush: 1500 ms by default, configurable, junk → default', async () => {
    const flushedWith: number[] = [];
    const log: Logger = {
      ...createLogger({ transport: new MemoryTransport() }),
      flush: (t) => {
        flushedWith.push(t ?? -1);
        return Promise.resolve();
      },
    };
    await createRequestErrorHandler(log)(new Error('x'), request(), context('render'));
    await createRequestErrorHandler(log, { flushTimeoutMs: 250 })(
      new Error('x'),
      request(),
      context('render'),
    );
    await createRequestErrorHandler(log, { flushTimeoutMs: NaN })(
      new Error('x'),
      request(),
      context('render'),
    );
    expect(flushedWith).toEqual([1500, 250, 1500]);
  });

  it('resolves at the bound when the transport hangs', async () => {
    vi.useFakeTimers();
    const log = createLogger({
      transport: { send: () => new Promise(() => {}), flush: () => new Promise(() => {}) },
    });
    const handler = createRequestErrorHandler(log);
    let resolved = false;
    void handler(new Error('x'), request(), context('render')).then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(1499);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it('never throws or rejects: a broken logger, malformed arguments', async () => {
    const broken: Logger = {
      ...createLogger({ transport: new MemoryTransport() }),
      error: () => {
        throw new Error('logger broke');
      },
      flush: () => Promise.reject(new Error('flush broke')),
    };
    const handler = createRequestErrorHandler(broken);
    await expect(handler(new Error('x'), request(), context('render'))).resolves.toBeUndefined();
    const { handler: ok } = setup();
    for (const bad of [undefined, null, 42, { headers: 42 }]) {
      await expect(ok(new Error('x'), bad as never, bad as never)).resolves.toBeUndefined();
    }
  });

  it('honours a custom message and ignores an empty one; nothing is logged above the threshold', async () => {
    const custom = setup({ message: 'Request failed' });
    await custom.handler(new Error('x'), request(), context('render'));
    expect(custom.transport.events[0]?.message).toBe('Request failed');
    const empty = setup({ message: '' });
    await empty.handler(new Error('x'), request(), context('render'));
    expect(empty.transport.events[0]?.message).toBe('Unhandled server error');

    const transport = new MemoryTransport();
    const quiet = createRequestErrorHandler(createLogger({ transport, level: 'fatal' }));
    await expect(quiet(new Error('x'), request(), context('render'))).resolves.toBeUndefined();
    expect(transport.events).toHaveLength(0);
  });
});
