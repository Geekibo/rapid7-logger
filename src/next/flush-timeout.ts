/**
 * The bound on the flush the Next helpers await or schedule (DESIGN §6.1, §7.3). 1500 ms by
 * default: the runtime may freeze the instant a handler returns.
 */
export const DEFAULT_NEXT_FLUSH_MS = 1500;

export function flushTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_NEXT_FLUSH_MS;
}
