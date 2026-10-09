// The logger for Edge routes: the immediate-send variant (DESIGN §6.3). The /edge entry carries
// no `server-only` of its own, because that package would throw at load outside Next (a
// Cloudflare Worker, say) — so this app-level module carries it, and Next makes a Client
// Component import of this file a build error.
import 'server-only';
import { createLogger } from '@geekibo/rapid7-logger/edge';

// Test hook only: the repository's own test points this app at a local server. Ignore it.
const port = process.env.RAPID7_LOG_SERVER_PORT;
const fetchOverride = port
  ? (url: string | URL | Request, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${port}${new URL(String(url)).pathname}`, init)
  : undefined;

export const edgeLog = createLogger({
  token: process.env.RAPID7_TOKEN,
  region: process.env.RAPID7_REGION ?? 'eu',
  service: 'nextjs-app',
  env: process.env.APP_ENV ?? 'local',
  level: process.env.LOG_LEVEL ?? 'info',
  fetch: fetchOverride as typeof fetch | undefined,
});
