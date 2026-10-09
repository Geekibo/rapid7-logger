import { describe, expect, it } from 'vitest';
import * as next from '../../src/next.js';

// The Next entry's runtime surface (DESIGN §8.3). It must stay importable on the Edge runtime,
// so it never re-exports anything from src/index or src/node.
describe('the Next entry point', () => {
  it('exports exactly these runtime names', () => {
    expect(Object.keys(next).sort()).toEqual([
      'createLogger',
      'createRequestErrorHandler',
      'withLogging',
    ]);
  });
});
