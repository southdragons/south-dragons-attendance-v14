// Temporary test-only receiver. No LINE messages are sent from this function.
export async function handle(request: Request, env: (key: string) => string | undefined, send: typeof fetch = fetch): Promise<Response> {
  const reply = (status: number) => new Response(null, { status });
  if (request.method !== 'POST') return reply(405);
  const secret = env('LINE_TEST_CHANNEL_SECRET');
  const code = env('LINE_TEST_CAPTURE_CODE');
  const botId = env('LINE_TEST_BOT_ID');
  const expires = Date.parse(env('LINE_TEST_CAPTURE_EXPIRES_AT') || '');
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!secret || !code || !botId || !url || !key || !Number.isFinite(expires) || Date.now() > expires) return reply(503);
  try {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > 65536) return reply(413);
    const signature = request.headers.get('x-line-signature') || '';
    if (!/^[A-Za-z0-9+/]{43}=$/.test(signature)) return reply(401);
    const hmacKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const bytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
    if (!await crypto.subtle.verify('HMAC', hmacKey, bytes, raw)) return reply(401);
    const body = JSON.parse(new TextDecoder().decode(raw));
    if (body.destination !== botId || !Array.isArray(body.events)) return reply(400);
    for (const event of body.events) {
      if (event.type !== 'message' || event.message?.type !== 'text' || event.message.text !== code || event.source?.type !== 'user' || !/^U[0-9a-f]{32}$/.test(event.source.userId || '')) continue;
      // Keep the first matching private conversation only; never overwrite the recipient.
      const result = await send(url.replace(/\/$/, '') + '/rest/v1/settings?on_conflict=key', {
        method: 'POST',
        headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify({ key: 'line_test_capture', value: { userId: event.source.userId, botId, capturedAt: new Date().toISOString() } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!result.ok) return reply(502);
    }
    return reply(200);
  } catch {
    return reply(400);
  }
}

if (import.meta.main) Deno.serve(request => handle(request, key => Deno.env.get(key)));
