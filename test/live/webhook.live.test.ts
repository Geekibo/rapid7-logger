import { describe, expect, it } from 'vitest';
import { formatEvent } from '../../src/core/formatter.js';
import { createLogger } from '../../src/core/logger.js';
import { MemoryTransport } from '../../src/transports/memory.js';
import { QueryApi } from './query-api.js';

// The live test (DESIGN §9.2). Skipped unless RAPID7_LIVE_TOKEN is set, so a clone with no
// credentials — and every fork pull request — has a green run. Credentials come from the
// environment only (`.env` is gitignored; see `.env.example`). Point it at a dedicated log.

const token = process.env.RAPID7_LIVE_TOKEN;
const region = process.env.RAPID7_LIVE_REGION ?? 'eu';
const logId = process.env.RAPID7_LIVE_LOG_ID;
const apiKey = process.env.RAPID7_QUERY_API_KEY;
const canReadBack = Boolean(logId && apiKey);

const LIVE_TIMEOUT_MS = 90_000;

function nestedError(): Error {
  try {
    JSON.parse('{ not json');
  } catch (inner) {
    return new Error('live test outer failure', { cause: inner });
  }
  throw new Error('unreachable');
}

describe.skipIf(!token)('live webhook', () => {
  const api = canReadBack ? new QueryApi({ region, logId: logId!, apiKey: apiKey! }) : undefined;

  it(
    'a lone event is accepted, and arrives within seconds',
    async () => {
      const marker = crypto.randomUUID();
      const log = createLogger({ token, region, service: 'rapid7-logger-live' });
      const sentAt = Date.now();
      log.info('live lone event', { marker });
      await log.flush(15_000);
      expect(log.stats()).toMatchObject({ sent: 1, failed: 0, dropped: 0, queued: 0 });

      if (!api) return; // accepted is all we can assert without the Query API
      const { entries, foundAfterMs } = await api.find(marker, sentAt);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.message).toMatch(
        new RegExp(
          `^\\[\\d\\d:\\d\\d:\\d\\d INF\\] live lone event service=rapid7-logger-live marker=${marker}$`,
        ),
      );
      // Rapid7's own stamp lands well under a second after the post (measured ~0.5 s); the
      // index that makes it searchable lags by ~10 s.
      expect((entries[0]?.timestamp ?? 0) - sentAt).toBeLessThan(5_000);
      expect(foundAfterMs).toBeLessThan(60_000);
    },
    LIVE_TIMEOUT_MS,
  );

  it.skipIf(!canReadBack)(
    'a flattened stack trace arrives as one intact entry',
    async () => {
      const marker = crypto.randomUUID();
      // Record what the formatter produced, to compare byte for byte with what was stored.
      const memory = new MemoryTransport();
      const shadow = createLogger({ transport: memory, service: 'rapid7-logger-live' });
      const log = createLogger({ token, region, service: 'rapid7-logger-live' });
      const err = nestedError();
      const sentAt = Date.now();
      shadow.error('live stack trace', err, { marker });
      log.error('live stack trace', err, { marker });
      await Promise.all([shadow.flush(1000), log.flush(15_000)]);
      expect(log.stats()).toMatchObject({ sent: 1, failed: 0 });

      const expected = formatEvent({
        ...memory.events[0]!,
        timestamp: memory.events[0]!.timestamp,
      });
      expect(expected).toContain('    at '); // a real multi-line stack, flattened
      expect(expected).not.toMatch(/[\r\n]/);

      const { entries } = await api!.find(marker, sentAt);
      expect(entries).toHaveLength(1);
      // The stored line differs from the shadow only in its timestamp prefix.
      expect(entries[0]?.message.slice(15)).toBe(expected.slice(15));
    },
    LIVE_TIMEOUT_MS,
  );
});
