import { handle } from './index.ts';
const uid = 'U' + 'a'.repeat(32);
const bot = 'U' + 'b'.repeat(32);
const values: Record<string, string> = {
  LINE_TEST_CHANNEL_SECRET: 'test-secret', LINE_TEST_CAPTURE_CODE: 'private-test-phrase', LINE_TEST_BOT_ID: bot,
  LINE_TEST_CAPTURE_EXPIRES_AT: '2099-01-01T00:00:00Z', SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
};
const env = (k: string) => values[k];
const event = { type: 'message', message: { type: 'text', text: 'private-test-phrase' }, source: { type: 'user', userId: uid } };
function check(ok: unknown) { if (!ok) throw Error('Test assertion failed'); }
async function request(body: unknown, secret = 'test-secret') {
  const text = JSON.stringify(body);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  return new Request('https://example.invalid', { method: 'POST', body: text, headers: { 'x-line-signature': btoa(String.fromCharCode(...sig)) } });
}
const noWrite: typeof fetch = () => { throw Error('Unexpected database write'); };
Deno.test('reject missing or wrong signatures before writes', async () => {
  check((await handle(new Request('https://example.invalid', { method: 'POST', body: '{}' }), env, noWrite)).status === 401);
  check((await handle(await request({ destination: bot, events: [event] }, 'wrong'), env, noWrite)).status === 401);
});
Deno.test('accept LINE verification with empty events', async () => {
  check((await handle(await request({ destination: bot, events: [] }), env, noWrite)).status === 200);
});
Deno.test('reject another channel and expired setup', async () => {
  check((await handle(await request({ destination: uid, events: [event] }), env, noWrite)).status === 400);
  check((await handle(await request({ destination: bot, events: [event] }), k => k === 'LINE_TEST_CAPTURE_EXPIRES_AT' ? '2000-01-01' : env(k), noWrite)).status === 503);
});
Deno.test('ignore unrelated messages and group messages', async () => {
  const events = [{ ...event, message: { type: 'text', text: 'unrelated' } }, { ...event, source: { type: 'group', userId: uid } }];
  check((await handle(await request({ destination: bot, events }), env, noWrite)).status === 200);
});
Deno.test('capture matching user privately without replacing existing capture', async () => {
  let calls = 0;
  const send: typeof fetch = (_url, init) => {
    calls++;
    const h = new Headers(init?.headers);
    check(h.get('Prefer') === 'resolution=ignore-duplicates,return=minimal');
    const stored = JSON.parse(init?.body as string);
    check(stored.key === 'line_test_capture' && stored.value.userId === uid && stored.value.botId === bot);
    check(!JSON.stringify(stored).includes('private-test-phrase'));
    return Promise.resolve(new Response(null, { status: 201 }));
  };
  check((await handle(await request({ destination: bot, events: [event] }), env, send)).status === 200);
  check(calls === 1);
});
Deno.test('report persistence failure so LINE can retry', async () => {
  const fail: typeof fetch = () => Promise.resolve(new Response(null, { status: 500 }));
  check((await handle(await request({ destination: bot, events: [event] }), env, fail)).status === 502);
});
