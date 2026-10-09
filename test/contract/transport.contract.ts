import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/core/logger.js';
import type { LogEvent, Transport } from '../../src/core/types.js';

// The Transport contract (DESIGN §4.3): `send` never throws and never rejects, and `flush` is
// bounded. Every transport runs this suite; it is the headline guarantee of the package —
// logging cannot break the application — tested like one.

export interface TransportContractSpec {
  readonly name: string;
  /** Build a fresh transport. When the transport posts over HTTP, `fetch` is the one to use. */
  create(fetchImpl?: typeof fetch): Transport;
  /** True for a transport whose failures come from `fetch`; enables the fetch-driven cases. */
  readonly drivenByFetch: boolean;
}

const AT = new Date('2026-10-08T14:22:07.123Z');
const event = (overrides: Partial<LogEvent> = {}): LogEvent => ({
  timestamp: AT,
  level: 'info',
  message: 'contract',
  context: {},
  ...overrides,
});

/** Delivery is a microtask away; enough ticks for a pass to start and settle. */
const drain = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function hostileEvents(): LogEvent[] {
  const hostileContext = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('ownKeys');
      },
    },
  );
  return [
    event({ context: hostileContext }),
    event({ message: 42 as unknown as string }),
    event({ level: 'loud' as unknown as LogEvent['level'] }),
    event({ timestamp: {} as unknown as Date }),
    event({ error: { name: 1, message: null } as unknown as LogEvent['error'] }),
    {} as unknown as LogEvent,
  ];
}

export function describeTransportContract(spec: TransportContractSpec): void {
  describe(`Transport contract: ${spec.name}`, () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    describe('send never throws and never rejects (invariant 3)', () => {
      it('for hostile events', async () => {
        const transport = spec.create();
        for (const hostile of hostileEvents()) {
          let outcome: Promise<unknown>;
          expect(() => {
            outcome = transport.send(hostile);
          }).not.toThrow();
          await expect(outcome!).resolves.not.toThrow();
        }
      });

      if (spec.drivenByFetch) {
        const cases: [string, () => typeof fetch][] = [
          [
            'fetch throws synchronously',
            () => () => {
              throw new Error('sync boom');
            },
          ],
          ['fetch rejects', () => () => Promise.reject(new Error('network'))],
          ['fetch returns 500', () => () => Promise.resolve(new Response('err', { status: 500 }))],
          ['fetch returns 401', () => () => Promise.resolve(new Response(null, { status: 401 }))],
          [
            'fetch returns malformed data',
            () => () =>
              Promise.resolve({
                nonsense: true,
              } as unknown as Response),
          ],
          ['fetch resolves to null', () => () => Promise.resolve(null as unknown as Response)],
        ];
        it.each(cases)('when %s', async (_name, makeFetch) => {
          const transport = spec.create(makeFetch());
          await expect(transport.send(event())).resolves.not.toThrow();
        });

        it('when fetch never resolves (timeout)', async () => {
          vi.useFakeTimers();
          // Hangs until aborted, as a real fetch does: the transport's timeout must end it.
          const hanging = ((_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')),
              );
            })) as unknown as typeof fetch;
          const pending = spec.create(hanging).send(event());
          await vi.runAllTimersAsync();
          await expect(pending).resolves.not.toThrow();
        });
      }
    });

    describe('flush is bounded (invariant 4)', () => {
      it('the transport resolves flush(timeoutMs) within the timeout', async () => {
        vi.useFakeTimers();
        const transport = spec.create(() => new Promise<Response>(() => {}));
        let resolved = false;
        void transport.flush(100).then(() => (resolved = true));
        await vi.advanceTimersByTimeAsync(100);
        expect(resolved).toBe(true);
      });

      it('the logger resolves flush(timeoutMs) at the timeout while a send hangs', async () => {
        vi.useFakeTimers();
        const hanging: Transport = {
          send: () => new Promise(() => {}),
          flush: () => new Promise(() => {}),
        };
        const log = createLogger({ transport: hanging });
        log.info('stuck');
        let resolved = false;
        void log.flush(100).then(() => (resolved = true));
        await vi.advanceTimersByTimeAsync(99);
        expect(resolved).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(resolved).toBe(true);
      });
    });

    describe('a failing transport never blocks the caller (invariant 5)', () => {
      it('1,000 calls return synchronously against a transport that never resolves', async () => {
        const stuck: Transport = {
          send: () => new Promise(() => {}),
          flush: () => Promise.resolve(),
        };
        const log = createLogger({ transport: stuck, queueLimit: 100, onInternalError: () => {} });
        const started = performance.now();
        let returned = 0;
        for (let i = 0; i < 1000; i++) {
          log.info('flood', { i });
          returned += 1;
        }
        const elapsed = performance.now() - started;
        expect(returned).toBe(1000);
        expect(elapsed).toBeLessThan(500);
        await drain();
        const { queued, dropped } = log.stats();
        // Every call is accounted for: waiting, dropped, or handed to the stuck transport.
        expect(queued + dropped).toBeGreaterThanOrEqual(1000 - 8);
        expect(dropped).toBeGreaterThan(0);
      });

      it('with the real transport, failures do not slow the call path', async () => {
        const log = createLogger({ transport: spec.create(), onInternalError: () => {} });
        const started = performance.now();
        for (let i = 0; i < 1000; i++) log.warn('x', { i });
        expect(performance.now() - started).toBeLessThan(500);
        await log.flush(1000);
      });
    });

    describe('the pipeline never mutates the caller', () => {
      it("the caller's context object is untouched and is not what the transport receives", async () => {
        const received: LogEvent[] = [];
        const spy: Transport = {
          send: (e) => {
            received.push(e);
            // A misbehaving transport mutating what it gets must not reach the caller either.
            (e.context as Record<string, unknown>).tampered = true;
            return spec.create().send(e);
          },
          flush: (t) => spec.create().flush(t),
        };
        const context = { user: { id: 7, roles: ['a', 'b'] }, password: 'secret', tags: ['x'] };
        const snapshot = structuredClone(context);
        const log = createLogger({ transport: spy, service: 'svc' }).child({ traceId: 't1' });
        log.info('hello', context);
        await log.flush(1000);
        expect(context).toEqual(snapshot);
        expect(received[0]?.context).not.toBe(context);
        expect(received[0]?.context).toMatchObject({ password: '[redacted]', tampered: true });
      });
    });
  });
}
