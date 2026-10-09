// One logger for the whole app. Imported by instrumentation.ts (both runtimes), Server
// Components, Server Actions and Route Handlers — never by a Client Component (that is a
// build error, and the token is a write credential).
import { createLogger } from '@geekibo/rapid7-logger/next';

// Test hook only: the repository's own test points this app at a local server. Ignore it.
const port = process.env.RAPID7_LOG_SERVER_PORT;
const fetchOverride = port
  ? (url: string | URL | Request, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${port}${new URL(String(url)).pathname}`, init)
  : undefined;

export const log = createLogger({
  token: process.env.RAPID7_TOKEN, // never NEXT_PUBLIC_: Next would inline it into the browser bundle
  region: process.env.RAPID7_REGION ?? 'eu',
  service: 'nextjs-app',
  env: process.env.APP_ENV ?? 'local',
  level: process.env.LOG_LEVEL ?? 'info',
  fetch: fetchOverride as typeof fetch | undefined,
});
