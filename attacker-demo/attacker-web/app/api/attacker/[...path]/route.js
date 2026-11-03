export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const API = process.env.ATTACKER_API_URL || 'http://127.0.0.1:6060';
const PROTECTED = new Set(['run', 'http', 'ssh', 'reset']);
const ALLOWED = new Set(['health', 'scenarios', ...PROTECTED]);

async function proxy(request, context) {
  const segments = context.params.path ?? [];
  if (segments.length !== 1 || !ALLOWED.has(segments[0])) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  const path = segments[0];
  const headers = new Headers({ accept: request.headers.get('accept') || '*/*' });
  if (PROTECTED.has(path)) {
    const token = process.env.ATTACKER_API_TOKEN;
    if (!token) return Response.json({ error: 'attacker_api_not_configured' }, { status: 503 });
    headers.set('authorization', `Bearer ${token}`);
  }
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);

  try {
    const upstream = await fetch(`${API}/${path}`, {
      method: request.method,
      headers,
      ...(request.method === 'GET' || request.method === 'HEAD'
        ? {}
        : { body: Buffer.from(await request.arrayBuffer()) }),
      signal: request.signal,
      cache: 'no-store',
    });
    const responseHeaders = new Headers();
    const upstreamType = upstream.headers.get('content-type');
    const cacheControl = upstream.headers.get('cache-control');
    if (upstreamType) responseHeaders.set('content-type', upstreamType);
    if (cacheControl) responseHeaders.set('cache-control', cacheControl);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return Response.json({ error: 'attacker_api_unavailable' }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
