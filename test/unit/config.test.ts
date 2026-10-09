import { describe, expect, it } from 'vitest';
import {
  QUEUE_DEFAULTS,
  REGIONS,
  resolveConfig,
  resolveLevel,
  resolveQueueOptions,
} from '../../src/core/config.js';

// Shape-valid but not a real token: the endpoint accepts any GUID (§2.6), so nothing here can
// or should be a credential.
const GUID = '12345678-abcd-4ef0-9876-0123456789ab';

describe('resolveConfig', () => {
  it('treats an absent, empty or whitespace token as "no token"', () => {
    for (const token of [undefined, '', '   ']) {
      const result = resolveConfig(token, undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem).toMatch(/no token/);
    }
  });

  it('rejects a malformed token without echoing it (invariant 9)', () => {
    const result = resolveConfig('not-a-token-value', undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toMatch(/GUID/);
      expect(result.problem).not.toContain('not-a-token-value');
    }
  });

  it('accepts a GUID in any case, trimmed', () => {
    expect(resolveConfig(GUID.toUpperCase(), undefined)).toEqual({
      ok: true,
      token: GUID.toUpperCase(),
      region: 'eu',
    });
    expect(resolveConfig(`  ${GUID}\n`, 'us')).toEqual({ ok: true, token: GUID, region: 'us' });
  });

  it('accepts every region, case-insensitively, and defaults to eu', () => {
    expect(REGIONS).toEqual(['eu', 'us', 'au', 'ca', 'jp']);
    for (const region of REGIONS) {
      expect(resolveConfig(GUID, region)).toMatchObject({ ok: true, region });
    }
    expect(resolveConfig(GUID, 'EU ')).toMatchObject({ ok: true, region: 'eu' });
    expect(resolveConfig(GUID, undefined)).toMatchObject({ ok: true, region: 'eu' });
  });

  it('rejects an unknown region, naming it', () => {
    const result = resolveConfig(GUID, 'mars');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/region "mars"/);
  });
});

describe('resolveLevel', () => {
  it('defaults to info', () => {
    expect(resolveLevel(undefined)).toEqual({ level: 'info' });
  });

  it('parses loosely and falls back to info with a problem for junk', () => {
    expect(resolveLevel('DEBUG')).toEqual({ level: 'debug' });
    expect(resolveLevel('verbose')).toMatchObject({
      level: 'info',
      problem: expect.stringMatching(/"verbose"/) as string,
    });
  });
});

describe('resolveQueueOptions', () => {
  it('uses the .NET defaults', () => {
    expect(QUEUE_DEFAULTS).toEqual({
      batchSize: 50,
      flushIntervalMs: 2000,
      queueLimit: 10_000,
      maxConcurrency: 8,
    });
    expect(resolveQueueOptions({})).toEqual({ options: QUEUE_DEFAULTS, problems: [] });
  });

  it('floors valid values, allows flushIntervalMs 0, and names each invalid one', () => {
    const { options, problems } = resolveQueueOptions({
      batchSize: 2.9,
      flushIntervalMs: 0,
      queueLimit: -1,
      maxConcurrency: NaN,
    });
    expect(options).toEqual({
      batchSize: 2,
      flushIntervalMs: 0,
      queueLimit: 10_000,
      maxConcurrency: 8,
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/queueLimit -1/);
    expect(problems[1]).toMatch(/maxConcurrency NaN/);
  });
});
