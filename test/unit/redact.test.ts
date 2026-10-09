import { describe, expect, it } from 'vitest';
import { formatEvent } from '../../src/core/formatter.js';
import {
  createRedactor,
  DEFAULT_REDACT_KEYS,
  DEFAULT_REDACT_PATTERNS,
  normaliseKey,
} from '../../src/core/redact.js';
import type { LogEvent } from '../../src/core/types.js';

const SECRET = 'hunter2-SENTINEL';
const AT = new Date('2026-10-08T14:22:07.123Z');

function event(overrides: Partial<LogEvent> = {}): LogEvent {
  return { timestamp: AT, level: 'info', message: 'm', context: {}, ...overrides };
}

const redact = createRedactor();
const run = (context: Record<string, unknown>) => redact(event({ context })).context;

describe('key matching', () => {
  it('normalises case, dashes, underscores and whitespace', () => {
    expect(normaliseKey('X-Api-Key')).toBe('xapikey');
    expect(normaliseKey('refresh_token ')).toBe('refreshtoken');
  });

  it.each([
    'password',
    'Password',
    'PASSWORD',
    'dbPassword',
    'passwd',
    'pwd',
    'secret',
    'clientSecret',
    'client_secret',
    'token',
    'refresh_token',
    'accessToken',
    'apiKey',
    'api_key',
    'x-api-key',
    'authorization',
    'Authorization',
    'cookie',
    'set-cookie',
    'credential',
    'credentials',
    'privateKey',
    'private-key',
  ])('redacts %s', (key) => {
    expect(run({ [key]: SECRET })).toEqual({ [key]: '[redacted]' });
  });

  it('leaves ordinary keys alone', () => {
    const safe = {
      traceId: 'abc',
      service: 'svc',
      env: 'prod',
      userId: 7,
      author: 'x',
      session: 's',
    };
    expect(run(safe)).toEqual(safe);
  });

  it('has the documented false positives', () => {
    expect(run({ tokenCount: 12, maxTokens: 100 })).toEqual({
      tokenCount: '[redacted]',
      maxTokens: '[redacted]',
    });
  });

  it('replaces the whole value whatever its type', () => {
    expect(run({ password: { nested: SECRET }, token: [SECRET], secret: 42 })).toEqual({
      password: '[redacted]',
      token: '[redacted]',
      secret: '[redacted]',
    });
  });
});

describe('nesting (done when)', () => {
  it('redacts a secret three levels deep', () => {
    expect(run({ a: { b: { c: { password: SECRET, keep: 1 } } } })).toEqual({
      a: { b: { c: { password: '[redacted]', keep: 1 } } },
    });
  });

  it('redacts inside an array', () => {
    expect(run({ users: [{ name: 'a', token: SECRET }, { name: 'b' }] })).toEqual({
      users: [{ name: 'a', token: '[redacted]' }, { name: 'b' }],
    });
  });

  it("redacts an Error's own properties in context, keeping it an Error", () => {
    const err = Object.assign(new RangeError(`failed with Bearer ${SECRET}`), {
      password: SECRET,
      code: 7,
    });
    const out = run({ err }).err as Error & { password: string; code: number };
    expect(out).toBeInstanceOf(Error);
    expect(out.name).toBe('RangeError');
    expect(out.message).toBe('failed with Bearer [redacted]');
    expect(out.stack).not.toContain(SECRET);
    expect(out.password).toBe('[redacted]');
    expect(out.code).toBe(7);
    expect(formatEvent(redact(event({ context: { err } })))).toContain(
      'err="RangeError: failed with Bearer [redacted]"',
    );
  });

  it('redacts the positional error through patterns', () => {
    const out = redact(
      event({
        error: {
          name: 'Error',
          message: `Bearer ${SECRET}`,
          stack: `Error: Bearer ${SECRET}\n    at https://x/?t=1`,
          digest: 'd',
        },
      }),
    );
    expect(out.error).toEqual({
      name: 'Error',
      message: 'Bearer [redacted]',
      stack: 'Error: Bearer [redacted]\n    at https://x/?t=1',
      digest: 'd',
    });
  });
});

describe('patterns', () => {
  it('cover Bearer, Basic and bare JWTs, in the message and in values', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redact(
      event({
        message: `auth Bearer ${SECRET} and Basic dXNlcjpwYXNz and ${jwt}`,
        context: { header: `Bearer ${SECRET}`, note: `jwt ${jwt} end` },
      }),
    );
    expect(out.message).toBe('auth Bearer [redacted] and Basic [redacted] and [redacted]');
    expect(out.context).toEqual({ header: 'Bearer [redacted]', note: 'jwt [redacted] end' });
  });

  it('are all global and the defaults are exported', () => {
    expect(DEFAULT_REDACT_PATTERNS.every((p) => p.global)).toBe(true);
    expect(DEFAULT_REDACT_KEYS).toContain('password');
  });

  it('keys do not apply to the message', () => {
    expect(redact(event({ message: 'password' })).message).toBe('password');
  });
});

describe('bypass attempts', () => {
  it('materialises toJSON before redacting and leaves no callable behind', () => {
    const sneaky = { toJSON: () => ({ password: SECRET, fine: 1 }) };
    const out = run({ sneaky, fn: () => SECRET });
    expect(out).toEqual({ sneaky: { password: '[redacted]', fine: 1 }, fn: '[Function]' });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('walks Map and Set', () => {
    const out = run({
      m: new Map<string, unknown>([
        ['password', SECRET],
        ['ok', 1],
      ]),
      s: new Set([`Bearer ${SECRET}`]),
    });
    expect(out).toEqual({ m: { password: '[redacted]', ok: 1 }, s: ['Bearer [redacted]'] });
  });

  it('does not mutate the input', () => {
    const input = { password: SECRET, nested: { token: SECRET } };
    const copy = structuredClone(input);
    run(input);
    expect(input).toEqual(copy);
  });

  it('passes dates, bigints and primitives through', () => {
    const d = new Date(0);
    expect(run({ d, n: 1n, b: true, z: null, u: undefined })).toEqual({
      d,
      n: 1n,
      b: true,
      z: null,
      u: undefined,
    });
  });
});

describe('bounds (done when)', () => {
  it('does not hang or throw on a cyclic object', () => {
    const a: Record<string, unknown> = { password: SECRET };
    a.self = a;
    a.list = [a, { nested: a }];
    const out = run({ a });
    expect(out).toEqual({
      a: {
        password: '[redacted]',
        self: '[Circular]',
        list: ['[Circular]', { nested: '[Circular]' }],
      },
    });
  });

  it('does not flag shared references as cycles', () => {
    const shared = { n: 1 };
    expect(run({ x: shared, y: shared })).toEqual({ x: { n: 1 }, y: { n: 1 } });
  });

  it('caps depth', () => {
    let deep: Record<string, unknown> = { password: SECRET };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    expect(JSON.stringify(run({ deep }))).not.toContain(SECRET);
    expect(JSON.stringify(run({ deep }))).toContain('[MaxDepth]');
  });

  it('caps node count, failing closed', () => {
    const big = Array.from({ length: 20_000 }, (_, i) => (i === 19_999 ? { password: SECRET } : i));
    const out = run({ big }) as { big: unknown[] };
    expect(out.big.length).toBe(20_000);
    expect(out.big.at(-1)).toBe('[MaxNodes]');
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('never throws on hostile input', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys');
        },
      },
    );
    const getter = {
      get boom(): string {
        throw new Error('getter');
      },
    };
    const brokenToJSON = {
      toJSON() {
        throw new Error('toJSON');
      },
    };
    expect(run({ hostile, getter, brokenToJSON, ok: 1 })).toEqual({
      hostile: '[unserializable]',
      getter: { boom: '[unserializable]' },
      brokenToJSON: '[unserializable]',
      ok: 1,
    });
    expect(() =>
      redact(
        event({
          message: 42 as unknown as string,
          context: null as unknown as LogEvent['context'],
        }),
      ),
    ).not.toThrow();
  });
});

describe('options', () => {
  it('user keys and patterns extend the defaults', () => {
    const r = createRedactor({ keys: ['email'], patterns: [/\d{3}-\d{4}/] });
    expect(
      r(event({ message: 'call 555-1234', context: { email: 'a@b', password: 'p' } })),
    ).toMatchObject({
      message: 'call [redacted]',
      context: { email: '[redacted]', password: '[redacted]' },
    });
  });

  it('defaults: false drops the built-ins', () => {
    const r = createRedactor({ defaults: false, keys: ['ssn'] });
    expect(r(event({ context: { ssn: 1, password: 'p' } })).context).toEqual({
      ssn: '[redacted]',
      password: 'p',
    });
  });

  it('honours replacement and ignores junk entries', () => {
    const r = createRedactor({
      replacement: '***',
      keys: [42 as unknown as string, ''],
      patterns: ['x' as unknown as RegExp],
    });
    expect(r(event({ context: { password: 'p', x: 'x' } })).context).toEqual({
      password: '***',
      x: 'x',
    });
    expect(
      createRedactor({ replacement: 7 as unknown as string })(event({ context: { token: 't' } }))
        .context,
    ).toEqual({
      token: '[redacted]',
    });
  });
});
