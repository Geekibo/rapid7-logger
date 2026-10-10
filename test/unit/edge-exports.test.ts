import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as edge from '../../src/edge.js';

// The Edge entry's surface (DESIGN §6.3, §8.3): the logger, the transports, the formatter,
// redaction and the pure trace helpers — nothing from src/node (AsyncLocalStorage, process
// hooks) and nothing from src/next.
describe('the Edge entry point', () => {
  it('exports exactly these runtime names', () => {
    expect(Object.keys(edge).sort()).toEqual([
      'ConsoleTransport',
      'DEFAULT_REDACT_KEYS',
      'DEFAULT_REDACT_PATTERNS',
      'LEVELS',
      'LEVEL_MONIKERS',
      'MemoryTransport',
      'REGIONS',
      'Rapid7WebhookTransport',
      'captureConsole',
      'childOf',
      'createLogger',
      'createRedactor',
      'formatEvent',
      'formatTraceparent',
      'generateTraceContext',
      'generateTraceparent',
      'parseTraceparent',
      'readTraceparent',
    ]);
  });

  it('imports only the core and the transports, reads no env, and does not import server-only', () => {
    const source = readFileSync(new URL('../../src/edge.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec).toMatch(/^\.\/(core|transports)\//);
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/^import 'server-only'/m);
  });
});
