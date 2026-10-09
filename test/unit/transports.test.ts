import { describe, expect, it, vi } from 'vitest';
import { formatEvent } from '../../src/core/formatter.js';
import type { LogEvent } from '../../src/core/types.js';
import { ConsoleTransport, type ConsoleLike } from '../../src/transports/console.js';
import { MemoryTransport } from '../../src/transports/memory.js';

const AT = new Date('2026-10-08T14:22:07.123Z');
const ev = (
  level: LogEvent['level'],
  message = 'm',
  context: LogEvent['context'] = {},
): LogEvent => ({
  timestamp: AT,
  level,
  message,
  context,
});

function fakeConsole(): ConsoleLike & { calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = [];
  const method =
    (name: string) =>
    (...args: unknown[]) =>
      void calls.push([name, args]);
  return {
    calls,
    debug: method('debug'),
    info: method('info'),
    warn: method('warn'),
    error: method('error'),
  };
}

describe('ConsoleTransport', () => {
  it('prints exactly the formatted line, routed by level', async () => {
    const target = fakeConsole();
    const transport = new ConsoleTransport({ console: target });
    const levels: LogEvent['level'][] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    for (const level of levels) await transport.send(ev(level, 'hello', { a: 1, traceId: 'abc' }));
    expect(target.calls.map(([name]) => name)).toEqual([
      'debug',
      'debug',
      'info',
      'warn',
      'error',
      'error',
    ]);
    expect(target.calls[2]?.[1]).toEqual(['[14:22:07 INF] abc: _ hello a=1']);
    expect(target.calls[2]?.[1]?.[0]).toBe(
      formatEvent(ev('info', 'hello', { a: 1, traceId: 'abc' })),
    );
  });

  it('honours the formatter options', async () => {
    const target = fakeConsole();
    const transport = new ConsoleTransport({
      console: target,
      format: (e) => `custom ${e.message}\nx`,
      maxBytes: 128,
    });
    await transport.send(ev('info', 'm'.repeat(500)));
    const line = target.calls[0]?.[1]?.[0] as string;
    expect(line.startsWith('custom mmm')).toBe(true);
    expect(line).not.toMatch(/[\r\n]/);
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(128);
  });

  it('never throws or rejects, even when the console does, and flushes at once (invariant 3)', async () => {
    const broken: ConsoleLike = {
      debug: () => {
        throw new Error('x');
      },
      info: () => {
        throw new Error('x');
      },
      warn: () => {
        throw new Error('x');
      },
      error: () => {
        throw new Error('x');
      },
    };
    const transport = new ConsoleTransport({ console: broken });
    await expect(transport.send(ev('info'))).resolves.toBeUndefined();
    await expect(transport.flush()).resolves.toBeUndefined();
  });

  it('uses the global console by default', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await new ConsoleTransport().send(ev('info', 'global'));
    expect(info).toHaveBeenCalledWith('[14:22:07 INF] global');
    info.mockRestore();
  });
});

describe('MemoryTransport', () => {
  it('captures events in order and renders them as lines', async () => {
    const transport = new MemoryTransport();
    await transport.send(ev('info', 'one', { a: 1 }));
    await transport.send(ev('error', 'two'));
    expect(transport.events.map((e) => e.message)).toEqual(['one', 'two']);
    expect(transport.lines()).toEqual(['[14:22:07 INF] one a=1', '[14:22:07 ERR] two']);
  });

  it('honours the formatter options and clears', async () => {
    const transport = new MemoryTransport({ format: (e) => e.level });
    await transport.send(ev('warn'));
    expect(transport.lines()).toEqual(['warn']);
    transport.clear();
    expect(transport.events).toEqual([]);
    expect(transport.lines()).toEqual([]);
  });

  it('never throws and flushes at once (invariant 3)', async () => {
    const transport = new MemoryTransport();
    await expect(transport.send({} as unknown as LogEvent)).resolves.toBeUndefined();
    await expect(transport.flush(10)).resolves.toBeUndefined();
    expect(() => transport.lines()).not.toThrow();
  });
});
