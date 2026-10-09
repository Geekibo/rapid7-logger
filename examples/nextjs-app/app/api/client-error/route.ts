import { withLogging } from '@geekibo/rapid7-logger/next';
import { log } from '@/lib/log';

export const POST = withLogging(log, 'clientError', async (log, req: Request) => {
  const { message, stack, digest } = (await req.json()) as {
    message?: string;
    stack?: string;
    digest?: string;
  };
  log.error('Client error', { name: 'ClientError', message: String(message), stack, digest });
  return new Response(null, { status: 204 });
});
