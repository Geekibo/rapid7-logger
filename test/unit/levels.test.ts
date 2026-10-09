import { describe, expect, it } from 'vitest';
import {
  isEnabled,
  isLevel,
  LEVEL_MONIKERS,
  LEVELS,
  levelRank,
  parseLevel,
} from '../../src/core/levels.js';

describe('levels', () => {
  it('are the fixed set, in severity order (§5.2)', () => {
    expect(LEVELS).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
    expect(LEVELS.map(levelRank)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('map to the monikers Rapid7 users already search for', () => {
    expect(LEVEL_MONIKERS).toEqual({
      trace: 'TRC',
      debug: 'DBG',
      info: 'INF',
      warn: 'WRN',
      error: 'ERR',
      fatal: 'FTL',
    });
  });

  it('parseLevel accepts the loosely-typed string an env var gives you', () => {
    expect(parseLevel('INFO')).toBe('info');
    expect(parseLevel(' warn ')).toBe('warn');
    expect(parseLevel('nope')).toBeUndefined();
    expect(parseLevel(42)).toBeUndefined();
    expect(parseLevel(undefined)).toBeUndefined();
  });

  it('isLevel does not accept inherited object keys', () => {
    expect(isLevel('toString')).toBe(false);
    expect(isLevel('constructor')).toBe(false);
  });

  it('isEnabled passes events at or above the threshold', () => {
    expect(LEVELS.filter((l) => isEnabled(l, 'trace'))).toEqual(LEVELS);
    expect(LEVELS.filter((l) => isEnabled(l, 'info'))).toEqual(['info', 'warn', 'error', 'fatal']);
    expect(LEVELS.filter((l) => isEnabled(l, 'fatal'))).toEqual(['fatal']);
  });
});
