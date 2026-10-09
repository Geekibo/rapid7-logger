import { describe, expect, it } from 'vitest';
import {
  correlationStamp,
  createFormatter,
  DEFAULT_MAX_BYTES,
  flattenLine,
  formatEvent,
  renderValue,
  truncateLine,
} from '../../src/core/formatter.js';
import { LEVELS } from '../../src/core/levels.js';
import type { LogEvent } from '../../src/core/types.js';

const bytes = (s: string) => new TextEncoder().encode(s).length;
const AT = new Date('2026-10-08T14:22:07.123Z');

function event(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    timestamp: AT,
    level: 'error',
    message: 'Survey export failed',
    context: {},
    ...overrides,
  };
}

describe('layout (§5.3)', () => {
  it('is [HH:mm:ss LVL] message key=value …', () => {
    expect(formatEvent(event({ context: { surveyId: 42, runId: 44 } }))).toBe(
      '[14:22:07 ERR] Survey export failed surveyId=42 runId=44',
    );
  });

  it('has no trailing space when the context is empty', () => {
    expect(formatEvent(event())).toBe('[14:22:07 ERR] Survey export failed');
  });

  it('uses every moniker', () => {
    expect(LEVELS.map((level) => formatEvent(event({ level })).slice(10, 13))).toEqual([
      'TRC',
      'DBG',
      'INF',
      'WRN',
      'ERR',
      'FTL',
    ]);
  });

  it('prints UTC regardless of the process time zone, and dashes for an invalid Date', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      expect(formatEvent(event())).toMatch(/^\[14:22:07 ERR\]/);
    } finally {
      process.env.TZ = previous;
    }
    expect(formatEvent(event({ timestamp: new Date(NaN) }))).toMatch(/^\[--:--:-- ERR\]/);
  });
});

describe('the clickable correlation stamp (§2.5)', () => {
  it('is exactly these bytes', () => {
    // §2.5: every byte is load-bearing and none of it is deducible from the docs. The colon and
    // space make Rapid7 parse the id as the KEY of a key/value pair — a bare id is not clickable
    // at all. The underscore is the pair's VALUE, so a message carrying its own `Label: value`
    // text cannot chain onto the stamp and steal the click. The trailing space separates it
    // from the message. The id is emitted in full. Re-measured from Node on 2026-10-08:
    // `where(<id>=_)` matches a line posted in this form.
    const id = '9f6f2b2b140b';
    const line = formatEvent(event({ context: { traceId: id } }));
    expect(line).toBe('[14:22:07 ERR] 9f6f2b2b140b: _ Survey export failed');
    const encoded = Array.from(new TextEncoder().encode(line));
    const afterPrefix = encoded.slice(
      '[14:22:07 ERR] '.length,
      '[14:22:07 ERR] '.length + id.length + 4,
    );
    expect(afterPrefix).toEqual([
      ...Array.from(new TextEncoder().encode(id)),
      0x3a,
      0x20,
      0x5f,
      0x20,
    ]);
    expect(correlationStamp(id)).toBe('9f6f2b2b140b: _ ');
  });

  it('appears only when the id is a non-empty string, and then leaves the pairs', () => {
    expect(formatEvent(event({ context: { traceId: '' } }))).toBe(
      '[14:22:07 ERR] Survey export failed traceId=""',
    );
    expect(formatEvent(event({ context: { traceId: '   ' } }))).toBe(
      '[14:22:07 ERR] Survey export failed traceId="   "',
    );
    expect(formatEvent(event({ context: { traceId: 42 } }))).toBe(
      '[14:22:07 ERR] Survey export failed traceId=42',
    );
    expect(formatEvent(event({ context: { traceId: 'abc', a: 1 } }))).toBe(
      '[14:22:07 ERR] abc: _ Survey export failed a=1',
    );
  });

  it('honours correlationKey and emits a long id in full', () => {
    const id = 'x'.repeat(200);
    expect(
      formatEvent(event({ context: { requestId: id } }), { correlationKey: 'requestId' }),
    ).toBe(`[14:22:07 ERR] ${id}: _ Survey export failed`);
  });
});

describe('flattening (invariant 2)', () => {
  it.each([
    ['a\nb', 'a b'],
    ['a\r\nb', 'a b'],
    ['a\rb', 'a b'],
    ['a\n\nb', 'a  b'],
    ['\n', ' '],
  ])('%j → %j', (input, expected) => {
    expect(flattenLine(input)).toBe(expected);
  });

  it('applies to the message, context keys and values, the stack and an override', () => {
    const err = { name: 'Error', message: 'x', stack: 'Error: x\n    at a\n    at b' };
    const line = formatEvent(
      event({ message: 'line1\nline2', context: { 'k\ney': 'v\r\nalue' }, error: err }),
    );
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toBe('[14:22:07 ERR] line1 line2 k ey="v\\r\\nalue" Error: x     at a     at b');
    expect(createFormatter({ format: () => 'a\nb' })(event())).toBe('a b');
  });
});

describe('context values (§5.3)', () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  const shared = { n: 1 };
  class Custom {
    toJSON() {
      throw new Error('no');
    }
  }
  it.each<[unknown, string | undefined]>([
    [undefined, undefined],
    ['bare', 'bare'],
    ['', '""'],
    ['two words', '"two words"'],
    ['a=b', '"a=b"'],
    ['say "hi"', '"say \\"hi\\""'],
    [42, '42'],
    [1.5, '1.5'],
    [true, 'true'],
    [null, 'null'],
    [10n, '10'],
    [Symbol('s'), '"Symbol(s)"'],
    [() => 1, '[Function]'],
    [new Date('2026-01-02T03:04:05.000Z'), '2026-01-02T03:04:05.000Z'],
    [new Date(NaN), 'Invalid Date'],
    [new RangeError('bad'), '"RangeError: bad"'],
    [{ a: 1, b: 'x' }, '{"a":1,"b":"x"}'],
    [[1, 'two'], '[1,"two"]'],
    [{ e: new Error('inner'), n: 5n }, '{"e":"Error: inner","n":"5"}'],
    [{ x: shared, y: shared }, '{"x":{"n":1},"y":{"n":1}}'],
    [new Map([['a', 1]]), '{}'],
    [new Custom(), '[unserializable]'],
  ])('%s → %s', (value, expected) => {
    expect(renderValue(value)).toBe(expected);
  });

  it('marks cycles instead of throwing', () => {
    expect(renderValue(cyclic)).toBe('{"a":1,"self":"[Circular]"}');
  });

  it('survives a throwing getter', () => {
    const hostile = {
      get boom(): string {
        throw new Error('getter');
      },
    };
    expect(renderValue(hostile)).toBe('[unserializable]');
  });
});

describe('the error (§5.3)', () => {
  it('goes last, as the V8 stack alone when it carries the head', () => {
    const stack = 'TypeError: nope\n    at fn (file.ts:1:2)';
    const line = formatEvent(
      event({ context: { a: 1 }, error: { name: 'TypeError', message: 'nope', stack } }),
    );
    expect(line).toBe(
      '[14:22:07 ERR] Survey export failed a=1 TypeError: nope     at fn (file.ts:1:2)',
    );
  });

  it('falls back to Name: message without a stack, and prefixes a non-V8 stack', () => {
    expect(formatEvent(event({ error: { name: 'HttpError', message: 'nope' } }))).toBe(
      '[14:22:07 ERR] Survey export failed HttpError: nope',
    );
    expect(formatEvent(event({ error: { name: 'E', message: 'm', stack: 'at x' } }))).toBe(
      '[14:22:07 ERR] Survey export failed E: m at x',
    );
    expect(formatEvent(event({ error: { name: 'E', message: '' } }))).toBe(
      '[14:22:07 ERR] Survey export failed E',
    );
  });

  it('emits the Next.js digest as a pair before the error text', () => {
    expect(formatEvent(event({ error: { name: 'Error', message: 'x', digest: 'abc123' } }))).toBe(
      '[14:22:07 ERR] Survey export failed digest=abc123 Error: x',
    );
  });
});

describe('truncation (§5.4)', () => {
  const prefix = '[14:22:07 ERR] ';
  const fill = (n: number, ch = 'x') => ch.repeat(n);

  it('leaves exactly 32,767 bytes alone and truncates 32,768', () => {
    const exact = formatEvent(event({ message: fill(DEFAULT_MAX_BYTES - prefix.length) }));
    expect(bytes(exact)).toBe(DEFAULT_MAX_BYTES);
    expect(exact).not.toContain('truncated');

    const over = formatEvent(event({ message: fill(DEFAULT_MAX_BYTES + 1 - prefix.length) }));
    expect(bytes(over)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    const match = /^(.*) … \[truncated (\d+) of (\d+) bytes\]$/s.exec(over);
    expect(match).not.toBeNull();
    const [, kept, removed, total] = match ?? [];
    expect(Number(total)).toBe(DEFAULT_MAX_BYTES + 1);
    expect(bytes(kept ?? '') + Number(removed)).toBe(DEFAULT_MAX_BYTES + 1);
    expect(over.startsWith(prefix + 'xxx')).toBe(true);
  });

  it('counts UTF-8 bytes and cuts on a code-point boundary', () => {
    const euros = formatEvent(event({ message: fill(10_923, '€') }));
    expect(bytes(euros)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(euros).not.toContain('�');
    expect(euros.slice(prefix.length)).toMatch(/^€+ … \[truncated \d+ of 32784 bytes\]$/);

    const emoji = truncateLine('a'.repeat(100) + '😀'.repeat(100), 128);
    expect(bytes(emoji)).toBeLessThanOrEqual(128);
    expect(emoji).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it('reads as the §5.4 example for a large line', () => {
    const line = truncateLine('m'.repeat(180_503));
    expect(bytes(line)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(line).toMatch(/ … \[truncated \d+ of 180503 bytes\]$/);
  });

  it('keeps the prefix and the stamp', () => {
    const line = formatEvent(event({ context: { traceId: 'abc' }, message: fill(50_000) }), {
      maxBytes: 1000,
    });
    expect(line.startsWith('[14:22:07 ERR] abc: _ xxx')).toBe(true);
    expect(bytes(line)).toBeLessThanOrEqual(1000);
  });

  it('validates maxBytes', () => {
    const long = 'x'.repeat(40_000);
    expect(truncateLine(long, Infinity)).toBe(long);
    expect(bytes(truncateLine(long, 10))).toBeLessThanOrEqual(128);
    expect(bytes(truncateLine(long, 10))).toBeGreaterThan(100);
    for (const bad of [NaN, -1, 0, 'abc' as unknown as number]) {
      expect(bytes(truncateLine(long, bad))).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      expect(bytes(truncateLine(long, bad))).toBeGreaterThan(DEFAULT_MAX_BYTES - 50);
    }
  });
});

describe('the format override (§5.3)', () => {
  it('receives the event and is still flattened and truncated', () => {
    const f = createFormatter({ format: (e) => `${e.level}: ${e.message}\nnext`, maxBytes: 128 });
    expect(f(event())).toBe('error: Survey export failed next');
    expect(bytes(f(event({ message: 'x'.repeat(1000) })))).toBeLessThanOrEqual(128);
  });

  it('composes with formatEvent', () => {
    const f = createFormatter({ format: (e) => `app=x ${formatEvent(e)}` });
    expect(f(event())).toBe('app=x [14:22:07 ERR] Survey export failed');
  });

  it('falls back to the default line when it throws or returns a non-string', () => {
    const throwing = createFormatter({
      format: () => {
        throw new TypeError('nope');
      },
    });
    expect(throwing(event())).toBe(
      '[14:22:07 ERR] Survey export failed formatError="TypeError: nope"',
    );
    const wrong = createFormatter({ format: () => 42 as unknown as string });
    expect(wrong(event())).toMatch(
      /formatError="TypeError: format returned number, not a string"$/,
    );
  });
});

describe('never throws (invariant 3)', () => {
  it('survives hostile events', () => {
    const hostileContext = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys');
        },
      },
    );
    const inputs: LogEvent[] = [
      event({ context: hostileContext }),
      event({ message: 42 as unknown as string }),
      event({ timestamp: {} as unknown as Date }),
      event({ level: 'loud' as unknown as LogEvent['level'] }),
      event({ error: { name: 1, message: null } as unknown as LogEvent['error'] }),
      event({ context: null as unknown as LogEvent['context'] }),
    ];
    for (const input of inputs) {
      const line = formatEvent(input);
      expect(typeof line).toBe('string');
      expect(line).not.toMatch(/[\r\n]/);
    }
  });
});
