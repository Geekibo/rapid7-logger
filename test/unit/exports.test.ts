import { describe, expect, it } from 'vitest';
import * as pkg from '../../src/index.js';

// A cheap API-surface snapshot (DESIGN §8.3): adding or removing a runtime export is a
// deliberate act that updates this list.
describe('the Node entry point', () => {
  it('exports exactly these runtime names', () => {
    expect(Object.keys(pkg).sort()).toEqual([
      'DEFAULT_REDACT_KEYS',
      'DEFAULT_REDACT_PATTERNS',
      'LEVELS',
      'LEVEL_MONIKERS',
      'REGIONS',
      'createLogger',
      'createRedactor',
      'formatEvent',
    ]);
  });
});
