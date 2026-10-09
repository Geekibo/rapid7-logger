// The smallest useful program: confirm a token and region work before integrating.
//
//   RAPID7_TOKEN=<your ingestion token> RAPID7_REGION=eu node index.mjs
//
// With no RAPID7_TOKEN set it logs to the console instead, and tells you so — the logger never
// throws over configuration.
import { createLogger, outboundHeaders, withTrace } from '@geekibo/rapid7-logger';

// Test hook only: the repository's own test points the example at a local server. Ignore it.
const port = process.env.RAPID7_LOG_SERVER_PORT;
const fetchOverride = port
  ? (url, init) => fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init)
  : undefined;

const log = createLogger({
  token: process.env.RAPID7_TOKEN, // never hardcode this: it is a write credential
  region: process.env.RAPID7_REGION ?? 'eu',
  service: 'node-basic',
  env: process.env.APP_ENV ?? 'local',
  level: process.env.LOG_LEVEL ?? 'debug',
  fetch: fetchOverride,
});

log.debug('starting up', { pid: process.pid });
log.info('Survey published', { surveyId: 42, runId: 44 });
log.warn('Material sync lock contended', { holder: 'pod-7', waitedMs: 1200 });

try {
  JSON.parse('{ not json');
} catch (err) {
  log.error('Export failed', err, { surveyId: 42 }); // the Error is a positional argument
}

// A child carries bound context on every line it emits.
const reqLog = log.child({ userId: 'u-123' });
reqLog.info('cache miss', { key: 'survey:42' });

// A request: every line inside carries the trace id, stamped so it is clickable in Rapid7.
await withTrace(async () => {
  log.info('request received', { path: '/surveys/42' });
  // The header the next tier needs, ready to spread into fetch(): {...outboundHeaders()}.
  log.info('calling the api', { outbound: outboundHeaders().traceparent });
  reqLog.info('request done');
});

log.fatal('Pretend fatal, to show the level', { exiting: false });

// Bounded: returns when delivered or when 3 s pass, whichever is first.
await log.flush(3000);
const stats = log.stats();
console.log(`\nstats: ${JSON.stringify(stats)}`);
console.log(
  process.env.RAPID7_TOKEN
    ? `${stats.sent} lines accepted by Rapid7 — search the log for service=node-basic`
    : 'no RAPID7_TOKEN set, so everything above went to the console',
);
await log.close();
