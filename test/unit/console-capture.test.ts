import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, uncaptured } from '../../src/core/console-capture.js';
import type { ConsoleCaptureTarget } from '../../src/core/console-capture.js';
import { createLogger } from '../../src/core/logger.js';
import { ConsoleTransport } from '../../src/transports/console.js';
import { MemoryTransport } from '../../src/transports/memory.js';

// DESIGN §6.7. A fake console keeps the suite's own output untouched; the recursion cases use
// the real one, with every method stubbed and restored.

function fakeConsole() {
  const target = {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };
  const originals = { ...target };
  return { target: target as ConsoleCaptureTarget, originals };
}

function memoryLogger() {
  const transport = new MemoryTransport();
  const log = createLogger({ transport, level: 'trace' });
  return { transport, log };
}

describe('captureConsole: defaults', () => {
  it('forwards warn and error only, at their own levels, and leaves log/info/debug/trace alone', async () => {
    const { target, originals } = fakeConsole();
    const { transport, log } = memoryLogger();
    const restore = captureConsole(log, { console: target });

    target.warn('careful');
    target.error('broken');
    target.log('noise');
    target.info('noise');
    target.debug('noise');
    target.trace('noise');
    await log.flush();

    expect(transport.events.map((e) => [e.level, e.message])).toEqual([
      ['warn', 'careful'],
      ['error', 'broken'],
    ]);
    expect(target.log).toBe(originals.log);
    expect(target.info).toBe(originals.info);
    expect(target.debug).toBe(originals.debug);
    expect(target.trace).toBe(originals.trace);
    restore();
  });

  it('passes the call through to the original by default, with the original arguments', () => {
    const { target, originals } = fakeConsole();
    const { log } = memoryLogger();
    const restore = captureConsole(log, { console: target });
    const err = new Error('x');
    target.error('failed %s', 'hard', err, { a: 1 });
    expect(originals.error).toHaveBeenCalledExactlyOnceWith('failed %s', 'hard', err, { a: 1 });
    restore();
  });

  it('passthrough: false swallows the call', async () => {
    const { target, originals } = fakeConsole();
    const { transport, log } = memoryLogger();
    const restore = captureConsole(log, { console: target, passthrough: false });
    target.error('quiet');
    await log.flush();
    expect(originals.error).not.toHaveBeenCalled();
    expect(transport.events.map((e) => e.message)).toEqual(['quiet']);
    restore();
  });
});

describe('captureConsole: the level map', () => {
  it('honours a custom map, including log at info and trace at debug', async () => {
    const { target } = fakeConsole();
    const { transport, log } = memoryLogger();
    const restore = captureConsole(log, {
      console: target,
      levels: { log: 'info', trace: 'debug', error: 'fatal' },
    });
    target.log('a');
    target.trace('b');
    target.error('c');
    target.warn('not mapped');
    await log.flush();
    expect(transport.events.map((e) => [e.level, e.message])).toEqual([
      ['info', 'a'],
      ['debug', 'b'],
      ['fatal', 'c'],
    ]);
    restore();
  });

  it('false and unknown levels leave the method alone', async () => {
    const { target, originals } = fakeConsole();
    const { transport, log } = memoryLogger();
    const restore = captureConsole(log, {
      console: target,
      levels: { warn: false, error: 'loud' as never, log: 'info' },
    });
    expect(target.warn).toBe(originals.warn);
    expect(target.error).toBe(originals.error);
    target.log('only this');
    await log.flush();
    expect(transport.events.map((e) => e.message)).toEqual(['only this']);
    restore();
  });
});

describe('captureConsole: argument mapping', () => {
  async function map(...args: unknown[]) {
    const { target } = fakeConsole();
    const { transport, log } = memoryLogger();
    const restore = captureConsole(log, { console: target, passthrough: false });
    target.error(...args);
    await log.flush();
    restore();
    const event = transport.events[0];
    if (!event) throw new Error('no event');
    return event;
  }

  it('a leading string is the message; primitives are appended', async () => {
    const event = await map('count', 3, true, null, undefined, 10n);
    expect(event.message).toBe('count 3 true null undefined 10');
  });

  it('an Error becomes the error argument, not part of the message', async () => {
    const err = new TypeError('bad input');
    const event = await map('failed', err);
    expect(event.message).toBe('failed');
    expect(event.error).toMatchObject({ name: 'TypeError', message: 'bad input' });
    expect(event.error?.stack).toContain('bad input');
  });

  it('an error-like object counts as the error; a second one goes to context', async () => {
    const event = await map('x', { name: 'HttpError', message: 'nope' }, new Error('second'));
    expect(event.error).toMatchObject({ name: 'HttpError', message: 'nope' });
    expect((event.context.arg0 as { message: string }).message).toBe('second');
  });

  it('plain objects merge into context, later keys winning', async () => {
    const event = await map('x', { a: 1, b: 1 }, { b: 2, c: 3 });
    expect(event.context).toMatchObject({ a: 1, b: 2, c: 3 });
  });

  it('arrays, Maps and class instances land under argN so redaction can walk them', async () => {
    class Thing {
      password = 'hunter2';
    }
    const event = await map('x', [1, 2], new Map([['k', 'v']]), new Thing());
    expect(event.context).toMatchObject({ arg0: [1, 2] });
    expect(event.context.arg1).toBeDefined();
    expect(event.context.arg2).toMatchObject({ password: '[redacted]' });
  });

  it('credential-shaped keys in a forwarded object are redacted', async () => {
    const event = await map('login', { user: 'ann', token: 'abc' });
    expect(event.context).toMatchObject({ user: 'ann', token: '[redacted]' });
  });

  it('a non-string first argument: the error is the error and the message is the fallback', async () => {
    const err = new Error('alone');
    const event = await map(err);
    expect(event.message).toBe('(console.error)');
    expect(event.error).toMatchObject({ message: 'alone' });
  });

  it('a lone object: context only, fallback message', async () => {
    const event = await map({ id: 7 });
    expect(event.message).toBe('(console.error)');
    expect(event.context).toMatchObject({ id: 7 });
  });

  it('no arguments: the fallback message', async () => {
    const event = await map();
    expect(event.message).toBe('(console.error)');
  });

  it('interpolates %s %d %i %f %j %o %O and %%, appending what is left over', async () => {
    const event = await map(
      '%s=%d %i %f %j %o %O 100%% %s',
      'n',
      '42',
      3.9,
      '1.5',
      { a: 1 },
      [1],
      { b: 2 },
      'tail',
      'extra',
    );
    expect(event.message).toBe('n=42 3 1.5 {"a":1} [1] {"b":2} 100% tail extra');
  });

  it('%s with an object renders JSON; a placeholder with no argument is kept', async () => {
    const event = await map('v=%s next=%d', { a: 1 });
    expect(event.message).toBe('v={"a":1} next=%d');
  });

  it('a cyclic object through %j does not throw', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const event = await map('%j', cyclic);
    expect(event.message).toBe('[object]');
  });
});

describe('captureConsole: restore and idempotence', () => {
  it('restore puts the originals back and is safe to call twice', () => {
    const { target, originals } = fakeConsole();
    const { log } = memoryLogger();
    const restore = captureConsole(log, { console: target });
    expect(target.error).not.toBe(originals.error);
    restore();
    restore();
    expect(target.error).toBe(originals.error);
    expect(target.warn).toBe(originals.warn);
  });

  it('capturing twice restores first: the last call wins and restore returns to the originals', async () => {
    const { target, originals } = fakeConsole();
    const first = memoryLogger();
    const second = memoryLogger();
    captureConsole(first.log, { console: target });
    const restore = captureConsole(second.log, { console: target, passthrough: false });

    target.error('once');
    await first.log.flush();
    await second.log.flush();
    expect(first.transport.events).toHaveLength(0);
    expect(second.transport.events.map((e) => e.message)).toEqual(['once']);
    expect(originals.error).not.toHaveBeenCalled();

    restore();
    expect(target.error).toBe(originals.error);
  });

  it('leaves a method alone if something else patched it after us', () => {
    const { target, originals } = fakeConsole();
    const { log } = memoryLogger();
    const restore = captureConsole(log, { console: target });
    const foreign = vi.fn();
    target.error = foreign;
    restore();
    expect(target.error).toBe(foreign);
    expect(target.warn).toBe(originals.warn);
  });

  it('uncaptured() returns the original while captured and the current method otherwise', () => {
    const { target, originals } = fakeConsole();
    const { log } = memoryLogger();
    expect(uncaptured(target, 'error')).toBe(originals.error);
    const restore = captureConsole(log, { console: target });
    expect(uncaptured(target, 'error')).toBe(originals.error);
    expect(uncaptured(target, 'log')).toBe(originals.log);
    restore();
    expect(uncaptured({}, 'error')).toBeUndefined();
  });
});

describe('captureConsole: no recursion through the real console', () => {
  const stubs = {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    trace: vi.spyOn(console, 'trace').mockImplementation(() => {}),
  };
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
    for (const stub of Object.values(stubs)) stub.mockClear();
  });

  it('a console-only logger (no token) writes its line through the original error, once', async () => {
    const log = createLogger({}); // no token ⇒ ConsoleTransport on the global console
    restore = captureConsole(log);

    console.error('boom');
    await log.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The passthrough call, then the transport's rendered line — and nothing after.
    expect(stubs.error).toHaveBeenCalledTimes(2);
    expect(stubs.error.mock.calls[0]).toEqual(['boom']);
    expect(String(stubs.error.mock.calls[1]?.[0])).toMatch(/ERR\].*boom/);
  });

  it('without passthrough the transport line is the only output', async () => {
    const log = createLogger({});
    restore = captureConsole(log, { passthrough: false });
    console.error('boom');
    await log.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stubs.error).toHaveBeenCalledTimes(1);
    expect(String(stubs.error.mock.calls[0]?.[0])).toMatch(/ERR\].*boom/);
  });

  it("the logger's own startup warning goes to the original warn, never into a captured logger", () => {
    const { transport, log } = memoryLogger();
    restore = captureConsole(log);
    createLogger({ token: 'not-a-token' }); // malformed ⇒ one immediate console.warn
    expect(stubs.warn).toHaveBeenCalledOnce();
    expect(String(stubs.warn.mock.calls[0]?.[0])).toContain('[rapid7-logger]');
    expect(transport.events).toHaveLength(0);
  });

  it('a ConsoleTransport constructed BEFORE capture still writes through the original', async () => {
    const transport = new ConsoleTransport();
    const log = createLogger({ transport });
    restore = captureConsole(log, { passthrough: false });
    console.warn('w');
    await log.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stubs.warn).toHaveBeenCalledTimes(1);
    expect(String(stubs.warn.mock.calls[0]?.[0])).toMatch(/WRN\].*\bw\b/);
  });

  it('a user transport that writes to the console synchronously from send() does not loop', async () => {
    const seen: string[] = [];
    const log = createLogger({
      transport: {
        send(event) {
          seen.push(event.message);
          console.error('transport says', event.message); // the re-entrancy guard catches this
          return Promise.resolve();
        },
        flush: () => Promise.resolve(),
      },
    });
    restore = captureConsole(log, { passthrough: false });
    console.error('start');
    await log.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual(['start']);
  });
});
