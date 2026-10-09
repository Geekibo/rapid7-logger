import { withLogging } from '@geekibo/rapid7-logger/next';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

export const GET = withLogging(log, 'listSurveys', async (log, req: Request) => {
  if (new URL(req.url).searchParams.get('fail')) {
    throw new Error('boom: deliberate route error');
  }
  log.info('listing', { count: 2 });
  return Response.json({ surveys: [{ id: 42 }, { id: 44 }] });
});
