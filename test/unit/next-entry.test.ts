import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Invariant 7 at the source level (DESIGN §6.5): the Next entry starts with `import 'server-only'`
// so a Client Component import is a build error, and nothing under src/next reads the
// environment — the token is handed in by the app, from a non-NEXT_PUBLIC_ variable.
const next = new URL('../../src/next.ts', import.meta.url);
const nextDir = new URL('../../src/next/', import.meta.url);

describe('the Next entry source', () => {
  it("begins with import 'server-only'", () => {
    const source = readFileSync(next, 'utf8');
    const firstStatement = source
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('//'));
    expect(firstStatement).toBe("import 'server-only';");
  });

  it('never reads process.env', () => {
    const files = [readFileSync(next, 'utf8')];
    for (const name of readdirSync(nextDir)) {
      files.push(readFileSync(new URL(name, nextDir), 'utf8'));
    }
    for (const file of files) expect(file).not.toMatch(/process\.env/);
  });
});
