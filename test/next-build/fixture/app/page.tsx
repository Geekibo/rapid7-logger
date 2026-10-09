// The control: a Server Component may import the Next entry. This must build.
import { createLogger } from '@geekibo/rapid7-logger/next';

const log = createLogger({ token: process.env.RAPID7_TOKEN, service: 'next-build-guard' });

export default function Page() {
  log.info('server component rendered');
  return <main>ok</main>;
}
