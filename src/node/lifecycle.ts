// Explicit import rather than the global, so every invariant-8 layer (ESLint, the Edge build
// plugin, CI's grep) sees it if this module is ever pulled towards the Edge bundle.
import process from 'node:process';
import type { Logger } from '../core/types.js';

// Lifecycle flush (DESIGN §7.3): on SIGTERM, SIGINT and beforeExit, flush every registered
// logger with a bounded timeout, then get out of the way. Measured on Node 20.20 before #15:
// SIGTERM during a burst delivered 0 of 200 lines — the default disposition kills the process
// in ~20 ms. "Log once and exit" already worked, because an in-flight fetch keeps the loop
// alive; beforeExit here is defence in depth.

/** The slice of `process` the registry needs; a unit test fills it with an EventEmitter. */
export interface ProcessLike {
  readonly pid: number;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  listeners(event: string): readonly unknown[];
  kill(pid: number, signal: string): unknown;
}

export interface Lifecycle {
  /** Add a root logger. Returns its unregister function; the last unregister removes the hooks. */
  register(logger: Logger, timeoutMs: number): () => void;
}

/**
 * Marks our listeners so another copy of this module can recognise them. The package is dual
 * ESM/CJS; an app that loads both gets two registries, and a plain listener count would make
 * each think the other is the application's handler.
 */
export const OWNER_TAG = Symbol.for('@geekibo/rapid7-logger/lifecycle');

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;
type Signal = (typeof SIGNALS)[number];
type Handler = ((...args: unknown[]) => void) & { [OWNER_TAG]?: true };

interface Entry {
  readonly logger: Logger;
  readonly timeoutMs: number;
}

function isOurs(listener: unknown): boolean {
  return typeof listener === 'function' && (listener as Handler)[OWNER_TAG] === true;
}

function tag(fn: (...args: unknown[]) => void): Handler {
  const handler = fn as Handler;
  handler[OWNER_TAG] = true;
  return handler;
}

/** Every flush is bounded and never rejects (invariant 4); this adds no timer of its own. */
function flushAll(entries: Iterable<Entry>): Promise<void> {
  return Promise.all(
    [...entries].map((entry) => {
      try {
        return entry.logger.flush(entry.timeoutMs);
      } catch {
        return Promise.resolve();
      }
    }),
  ).then(
    () => undefined,
    () => undefined,
  );
}

function hasWork(entry: Entry): boolean {
  try {
    return entry.logger.stats().queued > 0;
  } catch {
    return false;
  }
}

export function createLifecycle(proc: ProcessLike): Lifecycle {
  const entries = new Set<Entry>();
  const flushing = new Set<Signal>();
  let installed = false;

  function detach(signal: Signal): void {
    proc.removeListener(signal, handlers[signal]);
  }

  /** Restore the default disposition and re-raise, so the process dies the conventional way. */
  function reraise(signal: Signal): void {
    detach(signal);
    // Only the copy that removes the last of our listeners re-raises: exactly one kill.
    if (proc.listeners(signal).length === 0) proc.kill(proc.pid, signal);
  }

  function onSignal(signal: Signal): void {
    // Ownership is decided at receipt: if the application has its own handler, it owns the
    // exit and we only hand it a drained queue. Never process.exit() from a library.
    const ownsExit = proc.listeners(signal).every(isOurs);
    if (flushing.has(signal)) {
      // A second signal while flushing (ctrl-c twice): stop waiting.
      if (ownsExit) reraise(signal);
      return;
    }
    flushing.add(signal);
    void flushAll(entries).then(() => {
      flushing.delete(signal);
      if (ownsExit) reraise(signal);
    });
  }

  function onBeforeExit(): void {
    // Nothing queued ⇒ return synchronously. Flushing schedules async work, which makes Node
    // fire beforeExit again; this guard is what ends that cycle.
    const pending = [...entries].filter(hasWork);
    if (pending.length === 0) return;
    void flushAll(pending);
  }

  const handlers: Record<Signal | 'beforeExit', Handler> = {
    SIGTERM: tag(() => onSignal('SIGTERM')),
    SIGINT: tag(() => onSignal('SIGINT')),
    beforeExit: tag(onBeforeExit),
  };

  function install(): void {
    if (installed) return;
    installed = true;
    for (const signal of SIGNALS) proc.on(signal, handlers[signal]);
    proc.on('beforeExit', handlers.beforeExit);
  }

  function uninstall(): void {
    if (!installed) return;
    installed = false;
    for (const signal of SIGNALS) detach(signal);
    proc.removeListener('beforeExit', handlers.beforeExit);
  }

  return {
    register(logger, timeoutMs) {
      const entry: Entry = { logger, timeoutMs };
      entries.add(entry);
      install();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        entries.delete(entry);
        if (entries.size === 0) uninstall();
      };
    },
  };
}

let singleton: Lifecycle | undefined;

/** The registry for this process, created on first use so importing the package has no side effect. */
export function processLifecycle(): Lifecycle {
  singleton ??= createLifecycle(process);
  return singleton;
}
