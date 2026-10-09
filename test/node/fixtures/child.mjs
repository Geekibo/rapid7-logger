// A child process for the lifecycle integration tests (DESIGN §7.3). Runs against the BUILT
// Node entry, so the real transport, queue and process exit are exercised. Usage:
//   node child.mjs <mode> <port> [timeoutMs]
// Modes: once | burst | handled. The webhook host is rewritten to a local server on <port>;
// the token is shape-valid and not real (the endpoint accepts any GUID, §2.6).
import { createLogger } from '../../../dist/index.js';

const [mode, port, timeoutArg] = process.argv.slice(2);
const timeoutMs = timeoutArg ? Number(timeoutArg) : undefined;

const localFetch = (url, init) => fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init);

const log = createLogger({
  token: 'deadbeef-dead-4bad-8bad-feedfacecafe',
  fetch: localFetch,
  lifecycle: timeoutMs === undefined ? undefined : { timeoutMs },
  onInternalError: () => {},
});

if (mode === 'handled') {
  // An application that owns its own exit: the library must flush but never re-raise.
  process.on('SIGTERM', () => {
    void log.flush(2000).then(() => process.exit(42));
  });
}

if (mode === 'once') {
  log.info('once and exit');
  // No flush, no await: the done-when is that this line is delivered anyway.
} else {
  for (let i = 0; i < 200; i++) log.info('burst', { i });
  process.stdout.write('ready\n');
  // Stay alive until signalled.
  setInterval(() => {}, 1000);
}
