// The CommonJS twin of child.mjs, for the "once" case only: proves the CJS build registers the
// same hooks. See child.mjs for the shape.
const { createLogger } = require('../../../dist/index.cjs');

const port = process.argv[2];
const log = createLogger({
  token: 'deadbeef-dead-4bad-8bad-feedfacecafe',
  fetch: (url, init) => fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init),
  onInternalError: () => {},
});
log.info('once and exit (cjs)');
