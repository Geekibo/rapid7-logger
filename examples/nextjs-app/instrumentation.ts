import type { Instrumentation } from 'next';
import { createRequestErrorHandler } from '@geekibo/rapid7-logger/next';
import { log } from '@/lib/log';

// Every error that escapes a Server Component render, a Route Handler or a Server Action lands
// here, on both runtimes. The annotation is the type-level check against the installed Next.
export const onRequestError: Instrumentation.onRequestError = createRequestErrorHandler(log);

export async function register() {
  log.info('server starting', { runtime: process.env.NEXT_RUNTIME });
}
