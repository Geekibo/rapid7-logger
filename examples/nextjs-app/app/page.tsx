import Link from 'next/link';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

export default function Home() {
  log.info('home rendered');
  return (
    <main>
      <h1>rapid7-logger — Next.js example</h1>
      <ul>
        <li>
          <a href="/api/surveys">GET /api/surveys</a> — a Route Handler (ok)
        </li>
        <li>
          <a href="/api/surveys?fail=1">GET /api/surveys?fail=1</a> — the same handler, throwing
        </li>
        <li>
          <Link href="/boom">/boom</Link> — a Server Component that throws while rendering
        </li>
        <li>
          <Link href="/action-boom">/action-boom</Link> — a Server Action that throws
        </li>
      </ul>
    </main>
  );
}
