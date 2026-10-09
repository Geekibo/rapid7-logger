import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  childOf,
  formatTraceparent,
  generateTraceContext,
  generateTraceparent,
  parseTraceparent,
  readTraceparent,
} from '../../src/core/traceparent.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const HEADER = `00-${TRACE}-${PARENT}-01`;

afterEach(() => vi.unstubAllGlobals());

describe('parseTraceparent', () => {
  it('parses a valid header, lower-casing and trimming', () => {
    expect(parseTraceparent(HEADER)).toEqual({ traceId: TRACE, parentId: PARENT, flags: '01' });
    expect(parseTraceparent(`  ${HEADER.toUpperCase()} `)).toEqual({
      traceId: TRACE,
      parentId: PARENT,
      flags: '01',
    });
  });

  it('keeps a non-empty tracestate', () => {
    expect(parseTraceparent(HEADER, ' congo=t61rcWkgMzE ')).toMatchObject({
      tracestate: 'congo=t61rcWkgMzE',
    });
    expect(parseTraceparent(HEADER, '   ')).not.toHaveProperty('tracestate');
  });

  it('tolerates extra fields on a future version but not on version 00', () => {
    expect(parseTraceparent(`01-${TRACE}-${PARENT}-01-extra`)).toMatchObject({ traceId: TRACE });
    expect(parseTraceparent(`${HEADER}-extra`)).toBeUndefined();
  });

  it.each([
    ['version ff', `ff-${TRACE}-${PARENT}-01`],
    ['all-zero trace id', `00-${'0'.repeat(32)}-${PARENT}-01`],
    ['all-zero parent id', `00-${TRACE}-${'0'.repeat(16)}-01`],
    ['short trace id', `00-${TRACE.slice(1)}-${PARENT}-01`],
    ['non-hex', `00-${'g'.repeat(32)}-${PARENT}-01`],
    ['missing flags', `00-${TRACE}-${PARENT}`],
    ['empty', ''],
  ])('rejects %s', (_name, header) => {
    expect(parseTraceparent(header)).toBeUndefined();
  });

  it('rejects non-strings', () => {
    expect(parseTraceparent(42)).toBeUndefined();
    expect(parseTraceparent(null)).toBeUndefined();
    expect(parseTraceparent({})).toBeUndefined();
  });
});

describe('generation', () => {
  it('produces well-formed, unique, sampled, non-zero contexts', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const context = generateTraceContext();
      expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(context.parentId).toMatch(/^[0-9a-f]{16}$/);
      expect(context.flags).toBe('01');
      expect(parseTraceparent(formatTraceparent(context))).toEqual(context);
      seen.add(context.traceId);
    }
    expect(seen.size).toBe(200);
    expect(parseTraceparent(generateTraceparent())).toBeDefined();
  });

  it('never yields an all-zero id even when the RNG does, then falls back without crypto', () => {
    let calls = 0;
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array) => {
        calls += 1;
        if (calls <= 2) array.fill(0);
        else array.fill(7);
        return array;
      },
    });
    const context = generateTraceContext();
    expect(context.traceId).not.toMatch(/^0+$/);
    expect(context.parentId).not.toMatch(/^0+$/);

    vi.stubGlobal('crypto', undefined);
    expect(parseTraceparent(generateTraceparent())).toBeDefined();
  });

  it('childOf keeps the trace and mints a new parent id', () => {
    const parent = { traceId: TRACE, parentId: PARENT, flags: '01', tracestate: 'a=b' };
    const child = childOf(parent);
    expect(child.traceId).toBe(TRACE);
    expect(child.flags).toBe('01');
    expect(child.tracestate).toBe('a=b');
    expect(child.parentId).toMatch(/^[0-9a-f]{16}$/);
    expect(child.parentId).not.toBe(PARENT);
  });
});

describe('readTraceparent', () => {
  it.each<[string, unknown]>([
    ['a raw string', HEADER],
    ['a Headers instance', new Headers({ traceparent: HEADER, tracestate: 'x=y' })],
    ['a plain headers object', { traceparent: HEADER }],
    ['a mixed-case key', { TraceParent: HEADER }],
    ['an array value (IncomingMessage style)', { traceparent: [HEADER, 'other'] }],
    ['a Request', new Request('https://example.test/', { headers: { traceparent: HEADER } })],
    ['something with headers', { headers: { traceparent: HEADER } }],
    ['a TraceContext', { traceId: TRACE, parentId: PARENT, flags: '01' }],
  ])('reads %s', (_name, source) => {
    expect(readTraceparent(source as Parameters<typeof readTraceparent>[0])).toMatchObject({
      traceId: TRACE,
      parentId: PARENT,
    });
  });

  it('picks up tracestate from headers', () => {
    expect(readTraceparent(new Headers({ traceparent: HEADER, tracestate: 'x=y' }))).toMatchObject({
      tracestate: 'x=y',
    });
  });

  it('returns undefined for nothing usable and never throws', () => {
    expect(readTraceparent(undefined)).toBeUndefined();
    expect(readTraceparent(null)).toBeUndefined();
    expect(readTraceparent({})).toBeUndefined();
    expect(readTraceparent({ traceparent: 'nope' })).toBeUndefined();
    expect(readTraceparent({ headers: 42 })).toBeUndefined();
    const hostile = {
      get boom(): string {
        throw new Error('getter');
      },
      get traceparent(): string {
        throw new Error('getter');
      },
    };
    expect(() => readTraceparent(hostile)).not.toThrow();
    expect(readTraceparent(hostile)).toBeUndefined();
  });
});
