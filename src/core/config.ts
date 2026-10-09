import { parseLevel } from './levels.js';
import type { Level, Region } from './types.js';

// Validation of the two values that decide where events go (DESIGN §13, settled 2026-10-08).
// The endpoint answers 204 to a well-formed wrong token or the wrong region (§2.6), so shape
// is the only thing that can be checked here. Problem messages must never contain the input:
// the token is a write credential (invariant 9).

export const REGIONS = ['eu', 'us', 'au', 'ca', 'jp'] as const satisfies readonly Region[];

/** An InsightOps ingestion token is a GUID. */
export const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_REGION: Region = 'eu';
export const DEFAULT_LEVEL: Level = 'info';

export type ResolvedConfig =
  | { readonly ok: true; readonly token: string; readonly region: Region }
  | { readonly ok: false; readonly problem: string };

export function isRegion(value: unknown): value is Region {
  return typeof value === 'string' && (REGIONS as readonly string[]).includes(value);
}

export function resolveConfig(
  token: string | undefined,
  region: string | undefined,
): ResolvedConfig {
  const trimmedToken = token?.trim() ?? '';
  if (trimmedToken === '') {
    return { ok: false, problem: 'no token configured' };
  }
  if (!TOKEN_PATTERN.test(trimmedToken)) {
    return {
      ok: false,
      problem: 'the token is not a GUID (expected 8-4-4-4-12 hex digits)',
    };
  }
  const normalisedRegion = region === undefined ? DEFAULT_REGION : region.trim().toLowerCase();
  if (!isRegion(normalisedRegion)) {
    return {
      ok: false,
      problem: `unknown region "${normalisedRegion}" (expected one of ${REGIONS.join(', ')})`,
    };
  }
  return { ok: true, token: trimmedToken, region: normalisedRegion };
}

export type ResolvedLevel = { readonly level: Level; readonly problem?: string };

export function resolveLevel(value: string | undefined): ResolvedLevel {
  if (value === undefined) return { level: DEFAULT_LEVEL };
  const level = parseLevel(value);
  if (level) return { level };
  return {
    level: DEFAULT_LEVEL,
    problem: `unknown level "${value}" (expected trace, debug, info, warn, error or fatal); using ${DEFAULT_LEVEL}`,
  };
}

// Queue options (§7.2): the .NET defaults, which have production mileage.
export interface QueueOptions {
  readonly batchSize: number;
  readonly flushIntervalMs: number;
  readonly queueLimit: number;
  readonly maxConcurrency: number;
}

export const QUEUE_DEFAULTS: QueueOptions = {
  batchSize: 50,
  flushIntervalMs: 2000,
  queueLimit: 10_000,
  maxConcurrency: 8,
};

const QUEUE_MINIMUMS: QueueOptions = {
  batchSize: 1,
  flushIntervalMs: 0,
  queueLimit: 1,
  maxConcurrency: 1,
};

export type ResolvedQueueOptions = { readonly options: QueueOptions; readonly problems: string[] };

export function resolveQueueOptions(input: Partial<QueueOptions>): ResolvedQueueOptions {
  const options = { ...QUEUE_DEFAULTS };
  const problems: string[] = [];
  for (const name of Object.keys(QUEUE_DEFAULTS) as (keyof QueueOptions)[]) {
    const value = input[name];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < QUEUE_MINIMUMS[name]) {
      problems.push(
        `invalid ${name} ${String(value)} (expected a number >= ${QUEUE_MINIMUMS[name]}); using ${QUEUE_DEFAULTS[name]}`,
      );
      continue;
    }
    options[name] = Math.floor(value);
  }
  return { options, problems };
}
