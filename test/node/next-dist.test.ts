import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Invariant 7 at the output level (DESIGN §6.5), against the BUILT package.
const dist = new URL('../../dist/', import.meta.url);
const hasDist = existsSync(new URL('next.js', dist));
if (process.env.CI && !hasDist) {
  throw new Error('test/node needs dist/: run npm run build before npm test (see ci.yml)');
}

const read = (name: string) => readFileSync(new URL(name, dist), 'utf8');

describe.skipIf(!hasDist)('the built Next entry', () => {
  it('starts with the server-only import in both formats, and the types are free of it', () => {
    const firstStatement = read('next.js')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('//'));
    expect(firstStatement).toBe('import "server-only";');
    const cjs = read('next.cjs');
    const firstRequire = /require\("([^"]+)"\)/.exec(cjs)?.[1];
    expect(firstRequire).toBe('server-only');
    expect(read('next.d.ts')).not.toContain('server-only');
    expect(read('next.d.cts')).not.toContain('server-only');
  });

  it('nothing in dist reads a NEXT_PUBLIC_ variable or touches a browser global', () => {
    for (const name of readdirSync(dist)) {
      const text = read(name);
      expect(text, name).not.toContain('NEXT_PUBLIC_');
      if (/\.(js|cjs)$/.test(name)) {
        expect(text, name).not.toMatch(/\b(window|navigator|document)\b/);
      }
    }
  });
});
