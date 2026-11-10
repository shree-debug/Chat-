import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { sweep } from '../src/index.js';
import { makeEnv } from './helpers.js';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ctx = { waitUntil: () => {} };
function client(env) {
  const call = async (m, p, { token, json, raw, mime, headers = {} } = {}) => {
    const h = { ...headers }; if (token) h.authorization = 'Bearer ' + token;
    let body; if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); } if (raw) { h['content-type'] = mime || 'image/png'; body = raw; }
    const r = await worker.fetch(new Request('https://t' + p, { method: m, headers: h, body }), env, ctx);
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : ct.includes('html') ? await r.text() : new Uint8Array(await r.arrayBuffer()) };
  };
  const reg = async (u) => (await call('POST', '/auth/register', { json: { username: u, password: 'password123' } })).body.token;
  const friends = async (a, ta, b, tb) => { await call('POST', '/friends/request', { token: ta, json: { username: b } }); await call('POST', '/friends/accept', { token: tb, json: { username: a } }); };
  return { call, reg, friends };
}

test('auth: validation, duplicates, login, bad token', async () => {
  const { call, reg } = client(makeEnv());
  assert.equal((await call('POST', '/auth/register', { json: { username: 'ab', password: 'password123' } })).status, 400);
  assert.equal((await call('POST', '/auth/register', { json: { username: 'alice', password: 'short' } })).status, 400);
  const t = await reg('alice');
  assert.equal((await call('POST', '/auth/register', { json: { username: 'alice', password: 'password123' } })).status, 409);
  assert.equal((await call('POST', '/auth/login', { json: { username: 'alice', password: 'wrongpass1' } })).status, 401);
  assert.equal((await call('POST', '/auth/login', { json: { username: 'ALICE', password: 'password123' } })).status, 200);
  assert.equal((await call('GET', '/me', { token: t })).body.username, 'alice');
  assert.equal((await call('GET', '/me', { token: t + 'x' })).status, 401);
  assert.equal((await call('GET', '/me')).status, 401);
});

test('auth endpoints are rate limited', async () => {
  const { call } = client(makeEnv({ RATE_AUTH: 3 }));
  const h = { 'cf-connecting-ip': '1.2.3.4' };
  const codes = []; for (let i = 0; i < 5; i++) codes.push((await call('POST', '/auth/login', { json: { username: 'nobody', password: 'x' }, headers: h })).status);
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
});

test('friends flow', async () => {
  const { call, reg } = client(makeEnv());
  const [a, b] = [await reg('fran'), await reg('fred')];
  assert.equal((await call('POST', '/friends/request', { token: a, json: { username: 'fred' } })).status, 201);
  assert.deepEqual((await call('GET', '/friends', { token: b })).body.incoming, ['fran']);
  assert.equal((await call('POST', '/friends/accept', { token: a, json: { username: 'fred' } })).status, 404);
  assert.equal((await call('POST', '/friends/accept', { token: b, json: { username: 'fran' } })).status, 200);
  assert.deepEqual((await call('GET', '/friends', { token: a })).body.friends, ['fred']);
});

test('snap: friends only, magic-byte check, view-once, media deleted from storage', async () => {
  const env = makeEnv(); const { call, reg, friends } = client(env);
  const [a, b, c] = [await reg('sam'), await reg('sue'), await reg('stu')];
  await friends('sam', a, 'sue', b);
  assert.equal((await call('POST', '/snaps?to=stu', { token: a, raw: png })).status, 403);
  assert.equal((await call('POST', '/snaps?to=sue', { token: a, raw: png, mime: 'text/html' })).status, 415);
  assert.equal((await call('POST', '/snaps?to=sue', { token: a, raw: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) })).status, 415);
  const { body } = await call('POST', '/snaps?to=sue&caption=hi', { token: a, raw: png });
  assert.equal(env.MEDIA.m.size, 1);
  assert.equal((await call('GET', '/snaps/inbox', { token: b })).body.length, 1);
  assert.equal((await call('GET', `/snaps/${body.id}/media`, { token: c })).status, 404);
  const v1 = await call('GET', `/snaps/${body.id}/media`, { token: b });
  assert.equal(v1.status, 200); assert.deepEqual([...v1.body], [...png]);
  assert.equal(env.MEDIA.m.size, 0);
  assert.equal((await call('GET', `/snaps/${body.id}/media`, { token: b })).status, 410);
  assert.equal((await call('GET', '/snaps/inbox', { token: b })).body.length, 0);
});

test('media size limit', async () => {
  const { call, reg, friends } = client(makeEnv());
  const [a, b] = [await reg('big'), await reg('bob')];
  await friends('big', a, 'bob', b);
  const huge = new Uint8Array(10 * 1024 * 1024 + 1); huge.set(png);
  assert.equal((await call('POST', '/snaps?to=bob', { token: a, raw: huge })).status, 413);
});

test('stories: friends only, viewers tracked, expiry sweep removes media', async () => {
  const env = makeEnv(); const { call, reg, friends } = client(env);
  const [a, b, c] = [await reg('tom'), await reg('tim'), await reg('tia')];
  await friends('tom', a, 'tim', b);
  const { body } = await call('POST', '/stories', { token: a, raw: png });
  assert.equal((await call('GET', '/stories', { token: b })).body.length, 1);
  assert.equal((await call('GET', '/stories', { token: c })).body.length, 0);
  assert.equal((await call('GET', `/stories/${body.id}/media`, { token: c })).status, 404);
  assert.equal((await call('GET', `/stories/${body.id}/media`, { token: b })).status, 200);
  assert.deepEqual((await call('GET', `/stories/${body.id}/viewers`, { token: a })).body, ['tim']);
  assert.equal((await call('GET', `/stories/${body.id}/viewers`, { token: b })).status, 404);
  await sweep(env, Date.now() + 25 * 3600 * 1000);
  assert.equal(env.MEDIA.m.size, 0);
  assert.equal((await call('GET', '/stories', { token: b })).body.length, 0);
});

test('chat + realtime delivery + push fallback when offline', async () => {
  const env = makeEnv(); const { call, reg, friends } = client(env);
  const [a, b] = [await reg('max'), await reg('mia')];
  await friends('max', a, 'mia', b);
  assert.equal((await call('POST', '/push-token', { token: b, json: { token: 'ExponentPushToken[abcdefghij]' } })).status, 200);
  const pushes = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => { pushes.push({ u, body: JSON.parse(init.body) }); return new Response('{}'); };
  try {
    env.HUB.online.add(String(1 + 1)); // mia (id 2) online -> realtime, no push
    assert.equal((await call('POST', '/messages', { token: a, json: { to: 'mia', body: 'hello' } })).status, 201);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(pushes.length, 0);
    env.HUB.online.clear(); // offline -> push
    await call('POST', '/messages', { token: a, json: { to: 'mia', body: 'again' } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(pushes.length, 1); assert.match(pushes[0].u, /exp\.host/); assert.equal(pushes[0].body[0].body, 'New message from max');
  } finally { globalThis.fetch = realFetch; }
  assert.ok(env.HUB.sent.some((e) => e.event === 'message' && e.from === 'max'));
  const hist = (await call('GET', '/messages/max', { token: b })).body;
  assert.deepEqual(hist.map((x) => x.body), ['hello', 'again']);
  assert.equal((await call('POST', '/messages', { token: a, json: { to: 'mia', body: '  ' } })).status, 400);
});

test('block: removes friendship and stops all contact; unblock works', async () => {
  const { call, reg, friends } = client(makeEnv());
  const [a, b] = [await reg('ann'), await reg('abe')];
  await friends('ann', a, 'abe', b);
  assert.equal((await call('POST', '/blocks', { token: b, json: { username: 'ann' } })).status, 200);
  assert.deepEqual((await call('GET', '/friends', { token: a })).body.friends, []);
  assert.equal((await call('POST', '/messages', { token: a, json: { to: 'abe', body: 'hi' } })).status, 403);
  assert.equal((await call('POST', '/snaps?to=abe', { token: a, raw: png })).status, 403);
  assert.equal((await call('POST', '/friends/request', { token: a, json: { username: 'abe' } })).status, 404);
  assert.deepEqual((await call('GET', '/blocks', { token: b })).body, ['ann']);
  await call('DELETE', '/blocks/ann', { token: b });
  assert.deepEqual((await call('GET', '/blocks', { token: b })).body, []);
});

test('reports are stored and visible only to admin', async () => {
  const { call, reg } = client(makeEnv());
  const [a] = [await reg('rita'), await reg('rude')];
  assert.equal((await call('POST', '/reports', { token: a, json: { username: 'rude', kind: 'user', reason: 'harassment' } })).status, 201);
  assert.equal((await call('POST', '/reports', { token: a, json: { username: 'rude', kind: 'bogus', reason: 'x' } })).status, 400);
  assert.equal((await call('GET', '/admin/reports', { token: a })).status, 401);
  const r = await call('GET', '/admin/reports', { token: 'admin-token-1234567' });
  assert.equal(r.status, 200); assert.equal(r.body[0].target, 'rude'); assert.equal(r.body[0].reporter, 'rita');
});

test('delete account removes user data and media', async () => {
  const env = makeEnv(); const { call, reg, friends } = client(env);
  const [a, b] = [await reg('dan'), await reg('dee')];
  await friends('dan', a, 'dee', b);
  await call('POST', '/snaps?to=dee', { token: a, raw: png }); await call('POST', '/stories', { token: a, raw: png });
  await call('POST', '/messages', { token: a, json: { to: 'dee', body: 'bye' } });
  assert.equal(env.MEDIA.m.size, 2);
  assert.equal((await call('DELETE', '/me', { token: a, json: { password: 'nope12345' } })).status, 401);
  assert.equal((await call('DELETE', '/me', { token: a, json: { password: 'password123' } })).status, 200);
  assert.equal(env.MEDIA.m.size, 0);
  assert.equal((await call('GET', '/me', { token: a })).status, 401);
  assert.deepEqual((await call('GET', '/friends', { token: b })).body.friends, []);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) c FROM messages').get().c, 0);
  assert.equal((await call('POST', '/auth/register', { json: { username: 'dan', password: 'password123' } })).status, 201);
});

test('public pages + health', async () => {
  const { call } = client(makeEnv());
  assert.equal((await call('GET', '/health')).status, 200);
  const p = await call('GET', '/privacy'); assert.equal(p.status, 200); assert.match(p.body, /help@test\.dev/);
  assert.equal((await call('GET', '/delete-account')).status, 200);
  assert.equal((await call('GET', '/nope')).status, 401); // unauthenticated probes learn nothing
});
