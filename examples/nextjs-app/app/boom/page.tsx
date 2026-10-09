export const dynamic = 'force-dynamic';

// A Server Component that throws while rendering: onRequestError sees it with routeType=render.
export default function Boom() {
  throw new Error('boom: deliberate render error');
}
