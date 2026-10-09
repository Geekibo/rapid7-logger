import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createFormatter, formatEvent, MIN_MAX_BYTES } from '../../src/core/formatter.js';
import { LEVELS } from '../../src/core/levels.js';
import type { LogEvent } from '../../src/core/types.js';

const bytes = (s: string) => new TextEncoder().encode(s).length;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Strings biased towards the characters that matter here: newlines, quotes, equals, multibyte.
const text = fc.oneof(
  fc.string({ unit: 'binary' }),
  fc.stringMatching(/^[a-z =\n\r"€😀]{0,40}$/u),
  fc.constantFrom('a\nb', 'a\r\nb', 'a\rb', '\n', 'Error: x\n    at y\n    at z'),
);

const value = fc.oneof(
  text,
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.date(),
  fc.jsonValue(),
);

const arbEvent: fc.Arbitrary<LogEvent> = fc.record({
  timestamp: fc.oneof(fc.date(), fc.constant(new Date(NaN))),
  level: fc.constantFrom(...LEVELS),
  message: text,
  context: fc.dictionary(fc.oneof(text, fc.constant('traceId')), value, { maxKeys: 6 }),
  error: fc.option(
    fc.record(
      { name: text, message: text, stack: fc.option(text, { nil: undefined }) },
      { requiredKeys: ['name', 'message'] },
    ),
    { nil: undefined },
  ),
});

const arbMaxBytes = fc.oneof(
  fc.integer({ min: MIN_MAX_BYTES, max: 40_000 }),
  fc.constant(Infinity),
);

const arbOverride = fc.option(
  fc.constantFrom(
    (e: LogEvent) => `${e.message}\n${JSON.stringify(e.context)}`,
    () => 'x\r\ny'.repeat(2000),
    (e: LogEvent) => `wrapped ${formatEvent(e)}`,
  ),
  { nil: undefined },
);

describe('formatter properties', () => {
  it('A: the output never contains a newline, for any event, cap or override', () => {
    fc.assert(
      fc.property(arbEvent, arbMaxBytes, arbOverride, (event, maxBytes, format) => {
        const line = createFormatter({ maxBytes, format })(event);
        expect(line).not.toMatch(/[\r\n]/);
      }),
      { numRuns: 500 },
    );
  });

  it('B: the output never exceeds maxBytes, never splits a code point, and is untouched when it fits', () => {
    fc.assert(
      fc.property(arbEvent, arbMaxBytes, (event, maxBytes) => {
        const unlimited = formatEvent(event, { maxBytes: Infinity });
        const capped = formatEvent(event, { maxBytes });
        expect(bytes(capped)).toBeLessThanOrEqual(maxBytes);
        expect(capped).not.toMatch(LONE_SURROGATE);
        if (bytes(unlimited) <= maxBytes) expect(capped).toBe(unlimited);
      }),
      { numRuns: 300 },
    );
  });

  it('C: a truncated line keeps its prefix and its marker arithmetic adds up', () => {
    fc.assert(
      fc.property(arbEvent, fc.integer({ min: MIN_MAX_BYTES, max: 2000 }), (event, maxBytes) => {
        const unlimited = formatEvent(event, { maxBytes: Infinity });
        const capped = formatEvent(event, { maxBytes });
        if (capped === unlimited) return;
        const match = /^(.*) … \[truncated (\d+) of (\d+) bytes\]$/s.exec(capped);
        expect(match).not.toBeNull();
        const [, kept, removed, total] = match ?? [];
        expect(Number(total)).toBe(bytes(unlimited));
        expect(bytes(kept ?? '') + Number(removed)).toBe(bytes(unlimited));
        expect(unlimited.startsWith(kept ?? '')).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
