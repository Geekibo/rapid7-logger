'use client';
// The misuse: a Client Component importing the Next entry. The guard test copies this file to
// app/bad/page.tsx and asserts that `next build` FAILS — the ingestion token is a write
// credential and must never reach a browser bundle (DESIGN §6.5).
import { createLogger } from '@geekibo/rapid7-logger/next';

const log = createLogger({ token: 'not-a-real-token' });

export default function BadPage() {
  log.info('this must never build');
  return <main>this must never build</main>;
}
