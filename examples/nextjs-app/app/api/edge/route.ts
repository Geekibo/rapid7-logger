import { withLogging } from '@geekibo/rapid7-logger/next';
import { edgeLog } from '@/lib/edge-log';

// An Edge Route Handler: the immediate-send logger from /edge, wrapped by withLogging from
// /next (which runs on both runtimes). Next 16 marks the Edge Runtime deprecated but still
// builds and serves it; this route exists to prove the /edge entry runs there.
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export const GET = withLogging(edgeLog, 'edgePing', async (log, req: Request) => {
  if (new URL(req.url).searchParams.get('fail')) throw new Error('boom: deliberate edge error');
  log.info('edge ping', { runtime: process.env.NEXT_RUNTIME });
  return Response.json({ ok: true });
});
