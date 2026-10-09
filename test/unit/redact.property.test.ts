import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRedactor, DEFAULT_REDACT_KEYS } from '../../src/core/redact.js';
import type { LogEvent } from '../../src/core/types.js';

const SECRET = 'S3CR3T-SENTINEL-VALUE';
const redact = createRedactor();
const AT = new Date(0);
const event = (context: Record<string, unknown>, message = 'm'): LogEvent => ({
  timestamp: AT,
  level: 'info',
  message,
  context,
});

const safeKey = fc
  .stringMatching(/^[a-z]{1,8}$/)
  .filter((k) => !DEFAULT_REDACT_KEYS.some((d) => k.includes(d.toLowerCase())));
const safeValue = fc.oneof(
  fc.stringMatching(/^[a-z0-9 ]{0,12}$/),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);
const { tree: safeTree } = fc.letrec((tie) => ({
  tree: fc.oneof(
    { depthSize: 'small', maxDepth: 5 },
    safeValue,
    fc.array(tie('tree'), { maxLength: 4 }),
    fc.dictionary(safeKey, tie('tree'), { maxKeys: 4 }),
  ),
}));

// A default term in random casing with random separators, e.g. `db_PassWord-x`.
const secretKey = fc
  .tuple(
    fc.constantFrom(...DEFAULT_REDACT_KEYS),
    fc.stringMatching(/^[a-z]{0,3}$/),
    fc.stringMatching(/^[a-z]{0,3}$/),
    fc.constantFrom('', '-', '_'),
  )
  .map(([term, pre, post, sep]) => {
    const cased = [...term].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('');
    return `${pre}${sep}${cased}${sep}${post}`;
  });

// Plant the secret under a matching key at a random path, or after Bearer in a string.
const planted: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(safeTree, fc.array(safeKey, { maxLength: 4 }), secretKey, fc.boolean())
  .map(([tree, path, key, asBearer]) => {
    const root: Record<string, unknown> = { base: tree };
    let node = root;
    for (const step of path) {
      const next: Record<string, unknown> = {};
      node[step] = next;
      node = next;
    }
    if (asBearer) node.note = `auth Bearer ${SECRET} done`;
    else node[key] = SECRET;
    return root;
  });

describe('redaction properties', () => {
  it('P1: never throws, even on cyclic input', () => {
    fc.assert(
      fc.property(safeTree, fc.boolean(), (tree, cycle) => {
        const context: Record<string, unknown> = { tree };
        if (cycle) context.self = context;
        expect(() => redact(event(context))).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('P2: a planted secret never survives', () => {
    fc.assert(
      fc.property(planted, (context) => {
        const out = redact(event(context, `Bearer ${SECRET}`));
        expect(JSON.stringify(out)).not.toContain(SECRET);
      }),
      { numRuns: 300 },
    );
  });

  it('P3: a safe tree is returned unchanged, with timestamp and level by reference', () => {
    fc.assert(
      fc.property(safeTree, (tree) => {
        const input = event({ tree });
        const out = redact(input);
        expect(out.context).toEqual({ tree });
        expect(out.timestamp).toBe(AT);
        expect(out.level).toBe('info');
      }),
      { numRuns: 200 },
    );
  });

  it('P4: is idempotent', () => {
    fc.assert(
      fc.property(planted, (context) => {
        const once = redact(event(context));
        expect(redact(once)).toEqual(once);
      }),
      { numRuns: 200 },
    );
  });
});
