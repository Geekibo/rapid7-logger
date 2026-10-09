import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  dependencies?: Record<string, string>;
  exports: Record<string, Record<string, unknown>>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  engines: { node: string };
  publishConfig: { access: string };
  repository: { url: string };
  files: string[];
  sideEffects: boolean | string[];
}

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as PackageJson;

// The packaging half of the design's guarantees (DESIGN §4.2). Each of these is something a
// careless edit to package.json could break without any other test noticing.
describe('package.json', () => {
  it('has zero runtime dependencies (CLAUDE.md invariant 6)', () => {
    // npm drops an empty "dependencies" object on install, so absent and {} both mean none.
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('exports exactly the Node, Next and Edge entry points', () => {
    expect(Object.keys(pkg.exports)).toEqual(['.', './next', './edge']);
  });

  it('ships no CJS build for the Edge entry point', () => {
    expect(pkg.exports['./edge']).not.toHaveProperty('require');
  });

  it('has no browser condition (CLAUDE.md invariant 7)', () => {
    for (const entry of Object.values(pkg.exports)) {
      expect(entry).not.toHaveProperty('browser');
    }
  });

  it('declares next and server-only as optional peers', () => {
    expect(pkg.peerDependencies).toEqual({ next: '>=15.0.0', 'server-only': '*' });
    expect(pkg.peerDependenciesMeta?.next?.optional).toBe(true);
    expect(pkg.peerDependenciesMeta?.['server-only']?.optional).toBe(true);
  });

  it('marks only the Next entry as having side effects (its server-only import must survive)', () => {
    expect(pkg.sideEffects).toEqual(['./dist/next.js', './dist/next.cjs']);
  });

  it('keeps the Node floor at 20.9', () => {
    expect(pkg.engines.node).toBe('>=20.9.0');
  });

  it('publishes publicly, with a repository URL npm provenance will match (DESIGN §10.3)', () => {
    expect(pkg.publishConfig.access).toBe('public');
    expect(pkg.repository.url).toBe('git+https://github.com/Geekibo/rapid7-logger.git');
  });

  it('ships only dist, the README and the licence', () => {
    expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE']);
  });
});
