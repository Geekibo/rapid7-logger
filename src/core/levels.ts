import type { Level } from './types.js';

/** Severity order, least to most severe. */
export const LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const satisfies readonly Level[];

/** The three-letter monikers Rapid7 users already search for (§5.2). */
export const LEVEL_MONIKERS: Readonly<Record<Level, string>> = {
  trace: 'TRC',
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
  fatal: 'FTL',
};

const RANK: Readonly<Record<Level, number>> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

export function levelRank(level: Level): number {
  return RANK[level];
}

export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && Object.hasOwn(RANK, value);
}

/** Accepts the loosely-typed string an environment variable gives you: `'INFO'`, `' warn '`. */
export function parseLevel(value: unknown): Level | undefined {
  if (typeof value !== 'string') return undefined;
  const normalised = value.trim().toLowerCase();
  return isLevel(normalised) ? normalised : undefined;
}

/** True when an event at `level` passes a logger whose threshold is `threshold`. */
export function isEnabled(level: Level, threshold: Level): boolean {
  return RANK[level] >= RANK[threshold];
}
