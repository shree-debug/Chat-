// ZYNQ API on Cloudflare Workers (D1 + R2 + Durable Objects). Built by Nexoria.
export { Hub } from './hub.js';

const DAY = 86400000, MAX_MEDIA = 10 * 1024 * 1024, TOKEN_TTL = 7 * DAY;
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const eq = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const json = (o, status = 200, h = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...h } });
const html = (s) => new Response(s, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- crypto ----------
async function hmacKey(secret) { return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function signToken(env, payload) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  return body + '.' + b64u(await crypto.subtle.sign('HMAC', await hmacKey(env.JWT_SECRET), enc.encode(body)));
}
async function verifyToken(env, t) {
  if (typeof t !== 'string' || !t.includes('.')) return null;
  const [body, sig] = t.split('.');
  try {
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(env.JWT_SECRET), unb64u(sig), enc.encode(body)))) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
async function hashPw(pw, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, k, 256); // 100k = Workers max
  return 'p1$' + b64u(salt) + '$' + b64u(bits);
}
const checkPw = async (pw, stored) => eq(await hashPw(pw, unb64u(stored.split('$')[1])), stored);

// ---------- db ----------
const mk = (env) => ({
  one: (sql, ...a) => env.DB.prepare(sql).bind(...a).first(),
  all: async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results,
  run: (sql, ...a) => env.DB.prepare(sql).bind(...a).run(),
});
async function limit(db, key, max, sec) {
  const w = Math.floor(Date.now() / (sec * 1000));
  const r = await db.one('INSERT INTO rate(k,w,n) VALUES(?,?,1) ON CONFLICT(k,w) DO UPDATE SET n=n+1 RETURNING n', key, w);
  if (r.n > max) throw new HttpError(429, 'too many requests, slow down');
}
const blocked = async (db, a, b) => !!(await db.one('SELECT 1 x FROM blocks WHERE (blocker=? AND blocked=?) OR (blocker=? AND blocked=?)', a, b, b, a));
const areFriends = async (db, a, b) => !!(await db.one("SELECT 1 x FROM friends WHERE status='accepted' AND ((requester=? AND addressee=?) OR (requester=? AND addressee=?))", a, b, b, a));
const userByName = (db, n) => db.one('SELECT id, username FROM users WHERE username = ?', String(n || '').toLowerCase());
const canInteract = async (db, a, b) => (await areFriends(db, a, b)) && !(await blocked(db, a, b));

// ---------- media ----------
const SIGS = [['image/jpeg', 0, [0xff, 0xd8, 0xff]], ['image/png', 0, [0x89, 0x50, 0x4e, 0x47]], ['image/webp', 8, [0x57, 0x45, 0x42, 0x50]], ['video/mp4', 4, [0x66, 0x74, 0x79, 0x70]]];
async function readMedia(req) {
  const mime = (req.headers.get('content-type') || '').split(';')[0];
  if (!SIGS.some((s) => s[0] === mime)) throw new HttpError(415, 'unsupported media type');
  if (Number(req.headers.get('content-length') || 0) > MAX_MEDIA) throw new HttpError(413, 'file too large (10 MB max)');
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) throw new HttpError(400, 'empty body');
  if (buf.byteLength > MAX_MEDIA) throw new HttpError(413, 'file too large (10 MB max)');
  const [, off, sig] = SIGS.find((s) => s[0] === mime); const u = new Uint8Array(buf);
  if (!sig.every((b, i) => u[off + i] === b)) throw new HttpError(415, 'file content does not match its type');
  return { buf, mime };
}
async function delKeys(env, keys) { for (let i = 0; i < keys.length; i += 500) await env.MEDIA.delete(keys.slice(i, i + 500)); }

// ---------- realtime + push ----------
async function sendPush(env, db, uid, title, body) {
  const toks = await db.all('SELECT token FROM push_tokens WHERE user=?', uid);
  if (!toks.length) return;
  try {
    await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(toks.map((t) => ({ to: t.token, title, body, sound: 'default' }))) });
  } catch (e) { console.error('push failed', e); }
}
async function notify(env, ctx, db, uid, event, data, push) {
  const job = (async () => {
    let delivered = 0;
    try {
      const r = await env.HUB.get(env.HUB.idFromName(String(uid))).fetch('https://hub/push', { method: 'POST', body: JSON.stringify({ event, ...data }) });
      delivered = (await r.json()).delivered;
    } catch (e) { console.error('hub failed', e); }
    if (!delivered && push) await sendPush(env, db, uid, 'ZYNQ', push);
  })();
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
}

// ---------- cleanup (cron) ----------
export async function sweep(env, now = Date.now()) {
  const db = mk(env);
  const snaps = await db.all('SELECT key FROM snaps WHERE expires < ? AND key IS NOT NULL', now);
  const stories = await db.all('SELECT id, key FROM stories WHERE expires < ?', now);
  await delKeys(env, [...snaps.map((s) => s.key), ...stories.map((s) => s.key)]);
  await db.run('DELETE FROM snaps WHERE expires < ?', now);
  await db.run('DELETE FROM story_views WHERE story IN (SELECT id FROM stories WHERE expires < ?)', now);
  await db.run('DELETE FROM stories WHERE expires < ?', now);
  await db.run('DELETE FROM rate WHERE w < ?', Math.floor(now / 60000) - 120);
}

// ---------- pages (templates: have a lawyer review before launch) ----------
const page = (title, body) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.6 system-ui;max-width:720px;margin:auto;padding:20px}</style><h1>${title}</h1>${body}`;
const privacy = (env) => page('ZYNQ Privacy Policy', `<p>ZYNQ is operated by Nexoria. Contact: ${esc(env.CONTACT_EMAIL || '')}</p>
<h3>Data we collect</h3><ul><li>Username and a salted hash of your password</li><li>Photos/videos you send as snaps (deleted after the recipient views them, or after 24 hours) and stories (deleted after 24 hours)</li><li>Chat messages you send</li><li>Your friends and blocked-users lists</li><li>A push-notification token if you enable notifications</li><li>Reports you submit about other users or content</li></ul>
<h3>How we use it</h3><p>Only to run the app: deliver snaps, stories and messages, send notifications, and keep the service safe (rate limiting, abuse reports). We do not sell your data or show ads.</p>
<h3>Sharing</h3><p>Content is visible only to the friends you send it to. We use Cloudflare to host the service. We may disclose data if legally required.</p>
<h3>Your choices</h3><p>You can delete your account in the app (Settings), or see <a href="/delete-account">account deletion</a>. Deleting removes your account, messages and media. Reports about abuse may be retained for safety.</p>
<h3>Children</h3><p>ZYNQ is not for children under 13.</p>`);
const deletePage = (env) => page('Delete your ZYNQ account', `<p>In the app: Settings → enter your password → Delete my account. This permanently deletes your account, messages, snaps and stories.</p><p>Can't access the app? Email ${esc(env.CONTACT_EMAIL || '')} from the address linked to your account request with your username.</p>`);

// ---------- router ----------
async function readJson(req) {
  if (Number(req.headers.get('content-length') || 0) > 65536) throw new HttpError(413, 'too large');
  try { return (await req.json()) || {}; } catch { throw new HttpError(400, 'bad json'); }
}

async function handle(req, env, ctx) {
  const url = new URL(req.url), p = url.pathname, m = req.method, db = mk(env);
  if (p === '/health') return json({ ok: true });
  if (m === 'GET' && p === '/privacy') return html(privacy(env));
  if (m === 'GET' && p === '/delete-account') return html(deletePage(env));

  if (m === 'GET' && p === '/admin/reports') {
    const a = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
    if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 16 || !eq(a, env.ADMIN_TOKEN)) throw new HttpError(401, 'unauthorized');
    return json(await db.all('SELECT r.id, u.username AS reporter, r.target, r.kind, r.ref, r.reason, r.created FROM reports r LEFT JOIN users u ON u.id=r.reporter ORDER BY r.id DESC LIMIT 200'));
  }

  if (m === 'POST' && (p === '/auth/register' || p === '/auth/login')) {
    await limit(db, 'auth:' + (req.headers.get('cf-connecting-ip') || 'unknown'), Number(env.RATE_AUTH || 20), 60);
    const { username, password } = await readJson(req);
    const u = String(username || '').toLowerCase();
    if (p === '/auth/register') {
      if (!/^[a-z0-9_]{3,20}$/.test(u)) throw new HttpError(400, 'username must be 3-20 chars: a-z 0-9 _');
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new HttpError(400, 'password must be 8-128 characters');
      if (await userByName(db, u)) throw new HttpError(409, 'username taken');
      const r = await db.run('INSERT INTO users(username, pass, created) VALUES(?,?,?)', u, await hashPw(password), Date.now());
      return json({ token: await signToken(env, { sub: r.meta.last_row_id, exp: Date.now() + TOKEN_TTL }), username: u }, 201);
    }
    const row = await db.one('SELECT id, pass FROM users WHERE username = ?', u);
    if (!row || typeof password !== 'string' || !(await checkPw(password, row.pass))) throw new HttpError(401, 'invalid credentials');
    return json({ token: await signToken(env, { sub: row.id, exp: Date.now() + TOKEN_TTL }), username: u });
  }

  const claims = await verifyToken(env, (req.headers.get('authorization') || '').replace(/^Bearer /, '') || url.searchParams.get('token'));
  const me = claims && (await db.one('SELECT id, username FROM users WHERE id = ?', claims.sub));
  if (!me) throw new HttpError(401, 'unauthorized');
  await limit(db, 'u:' + me.id, Number(env.RATE_USER || 240), 60);
  let mt;

  if (m === 'GET' && p === '/me') return json(me);
  if (m === 'GET' && p === '/ws') return env.HUB.get(env.HUB.idFromName(String(me.id))).fetch(req);

  if (m === 'DELETE' && p === '/me') {
    const { password } = await readJson(req);
    const row = await db.one('SELECT pass FROM users WHERE id=?', me.id);
    if (typeof password !== 'string' || !(await checkPw(password, row.pass))) throw new HttpError(401, 'wrong password');
    const keys = [...(await db.all('SELECT key FROM snaps WHERE (sender=? OR recipient=?) AND key IS NOT NULL', me.id, me.id)), ...(await db.all('SELECT key FROM stories WHERE owner=?', me.id))].map((r) => r.key);
    await delKeys(env, keys);
    await db.run('DELETE FROM story_views WHERE viewer=? OR story IN (SELECT id FROM stories WHERE owner=?)', me.id, me.id);
    for (const [t, c] of [['snaps', 'sender=? OR recipient=?'], ['stories', 'owner=? OR owner=?'], ['messages', 'sender=? OR recipient=?'], ['friends', 'requester=? OR addressee=?'], ['blocks', 'blocker=? OR blocked=?']]) await db.run(`DELETE FROM ${t} WHERE ${c}`, me.id, me.id);
    await db.run('DELETE FROM push_tokens WHERE user=?', me.id);
    await db.run('DELETE FROM users WHERE id=?', me.id);
    return json({ ok: true });
  }

  if (m === 'POST' && p === '/push-token') {
    const { token } = await readJson(req);
    if (typeof token !== 'string' || token.length < 10 || token.length > 200) throw new HttpError(400, 'bad token');
    await db.run('INSERT INTO push_tokens(user, token, created) VALUES(?,?,?) ON CONFLICT(token) DO UPDATE SET user=excluded.user', me.id, token, Date.now());
    return json({ ok: true });
  }

  // friends
  if (m === 'POST' && p === '/friends/request') {
    const t = await userByName(db, (await readJson(req)).username);
    if (!t || t.id === me.id || (await blocked(db, me.id, t.id))) throw new HttpError(404, 'user not found');
    if (await db.one('SELECT 1 x FROM friends WHERE (requester=? AND addressee=?) OR (requester=? AND addressee=?)', me.id, t.id, t.id, me.id)) throw new HttpError(409, 'already requested or friends');
    await db.run("INSERT INTO friends VALUES(?,?,'pending')", me.id, t.id);
    await notify(env, ctx, db, t.id, 'friend_request', { from: me.username }, `${me.username} sent you a friend request`);
    return json({ ok: true }, 201);
  }
  if (m === 'POST' && p === '/friends/accept') {
    const t = await userByName(db, (await readJson(req)).username);
    const r = t && (await db.run("UPDATE friends SET status='accepted' WHERE requester=? AND addressee=? AND status='pending'", t.id, me.id));
    if (!r || !r.meta.changes) throw new HttpError(404, 'no pending request');
    await notify(env, ctx, db, t.id, 'friend_accepted', { by: me.username }, `${me.username} accepted your friend request`);
    return json({ ok: true });
  }
  if (m === 'GET' && p === '/friends') {
    const notBlocked = 'AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker=? AND b.blocked=u.id) OR (b.blocker=u.id AND b.blocked=?))';
    return json({
      friends: (await db.all(`SELECT u.username FROM friends f JOIN users u ON u.id = CASE WHEN f.requester=? THEN f.addressee ELSE f.requester END WHERE f.status='accepted' AND (f.requester=? OR f.addressee=?) ${notBlocked}`, me.id, me.id, me.id, me.id, me.id)).map((x) => x.username),
      incoming: (await db.all(`SELECT u.username FROM friends f JOIN users u ON u.id=f.requester WHERE f.addressee=? AND f.status='pending' ${notBlocked}`, me.id, me.id, me.id)).map((x) => x.username),
    });
  }

  // block / report
  if (m === 'POST' && p === '/blocks') {
    const t = await userByName(db, (await readJson(req)).username);
    if (!t || t.id === me.id) throw new HttpError(404, 'user not found');
    await db.run('INSERT OR IGNORE INTO blocks VALUES(?,?,?)', me.id, t.id, Date.now());
    await db.run('DELETE FROM friends WHERE (requester=? AND addressee=?) OR (requester=? AND addressee=?)', me.id, t.id, t.id, me.id);
    return json({ ok: true });
  }
  if (m === 'GET' && p === '/blocks') return json((await db.all('SELECT u.username FROM blocks b JOIN users u ON u.id=b.blocked WHERE b.blocker=?', me.id)).map((x) => x.username));
  if (m === 'DELETE' && (mt = p.match(/^\/blocks\/([a-z0-9_]+)$/))) {
    const t = await userByName(db, mt[1]);
    if (t) await db.run('DELETE FROM blocks WHERE blocker=? AND blocked=?', me.id, t.id);
    return json({ ok: true });
  }
  if (m === 'POST' && p === '/reports') {
    const { username, kind, ref, reason } = await readJson(req);
    const t = await userByName(db, username);
    if (!t || !['user', 'snap', 'story', 'message'].includes(kind) || typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw new HttpError(400, 'invalid report');
    await db.run('INSERT INTO reports(reporter, target, kind, ref, reason, created) VALUES(?,?,?,?,?,?)', me.id, t.username, kind, String(ref || '').slice(0, 100), reason.trim(), Date.now());
    return json({ ok: true }, 201);
  }

  // snaps (view-once)
  if (m === 'POST' && p === '/snaps') {
    const to = await userByName(db, url.searchParams.get('to'));
    if (!to || !(await canInteract(db, me.id, to.id))) throw new HttpError(403, 'recipient must be a friend');
    const { buf, mime } = await readMedia(req);
    const id = crypto.randomUUID(), key = 'm/' + crypto.randomUUID(), now = Date.now();
    await env.MEDIA.put(key, buf, { httpMetadata: { contentType: mime } });
    await db.run('INSERT INTO snaps(id, sender, recipient, key, mime, caption, created, expires) VALUES(?,?,?,?,?,?,?,?)', id, me.id, to.id, key, mime, (url.searchParams.get('caption') || '').slice(0, 200), now, now + DAY);
    await notify(env, ctx, db, to.id, 'snap', { id, from: me.username }, `${me.username} sent you a snap`);
    return json({ id }, 201);
  }
  if (m === 'GET' && p === '/snaps/inbox') {
    return json(await db.all('SELECT s.id, u.username AS "from", s.caption, s.created FROM snaps s JOIN users u ON u.id=s.sender WHERE s.recipient=? AND s.viewed IS NULL AND s.expires > ? AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker=s.recipient AND b.blocked=s.sender)) ORDER BY s.created DESC', me.id, Date.now()));
  }
  if (m === 'GET' && (mt = p.match(/^\/snaps\/([\w-]+)\/media$/))) {
    const s = await db.one('SELECT * FROM snaps WHERE id=? AND recipient=?', mt[1], me.id);
    if (!s) throw new HttpError(404, 'not found');
    if (s.viewed || s.expires < Date.now() || !s.key) throw new HttpError(410, 'snap gone');
    const claim = await db.run('UPDATE snaps SET viewed=?, key=NULL WHERE id=? AND viewed IS NULL', Date.now(), s.id); // atomic claim: only one viewer wins
    if (!claim.meta.changes) throw new HttpError(410, 'snap gone');
    const obj = await env.MEDIA.get(s.key);
    if (!obj) throw new HttpError(410, 'snap gone');
    const body = await obj.arrayBuffer();
    await env.MEDIA.delete(s.key);
    await notify(env, ctx, db, s.sender, 'snap_opened', { id: s.id, by: me.username }, null);
    return new Response(body, { headers: { 'content-type': s.mime, 'cache-control': 'no-store' } });
  }

  // stories
  if (m === 'POST' && p === '/stories') {
    const { buf, mime } = await readMedia(req);
    const id = crypto.randomUUID(), key = 'm/' + crypto.randomUUID(), now = Date.now();
    await env.MEDIA.put(key, buf, { httpMetadata: { contentType: mime } });
    await db.run('INSERT INTO stories VALUES(?,?,?,?,?,?,?)', id, me.id, key, mime, (url.searchParams.get('caption') || '').slice(0, 200), now, now + DAY);
    return json({ id }, 201);
  }
  if (m === 'GET' && p === '/stories') {
    return json(await db.all("SELECT s.id, u.username AS owner, s.caption, s.created, s.expires FROM stories s JOIN users u ON u.id=s.owner WHERE s.expires > ? AND (s.owner=? OR (EXISTS(SELECT 1 FROM friends f WHERE f.status='accepted' AND ((f.requester=? AND f.addressee=s.owner) OR (f.addressee=? AND f.requester=s.owner))) AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker=? AND b.blocked=s.owner) OR (b.blocker=s.owner AND b.blocked=?)))) ORDER BY s.created DESC", Date.now(), me.id, me.id, me.id, me.id, me.id));
  }
  if (m === 'GET' && (mt = p.match(/^\/stories\/([\w-]+)\/media$/))) {
    const s = await db.one('SELECT * FROM stories WHERE id=? AND expires > ?', mt[1], Date.now());
    if (!s || (s.owner !== me.id && !(await canInteract(db, me.id, s.owner)))) throw new HttpError(404, 'not found');
    const obj = await env.MEDIA.get(s.key);
    if (!obj) throw new HttpError(404, 'not found');
    if (s.owner !== me.id) await db.run('INSERT OR IGNORE INTO story_views VALUES(?,?,?)', s.id, me.id, Date.now());
    return new Response(await obj.arrayBuffer(), { headers: { 'content-type': s.mime, 'cache-control': 'private, max-age=300' } });
  }
  if (m === 'GET' && (mt = p.match(/^\/stories\/([\w-]+)\/viewers$/))) {
    if (!(await db.one('SELECT 1 x FROM stories WHERE id=? AND owner=?', mt[1], me.id))) throw new HttpError(404, 'not found');
    return json((await db.all('SELECT u.username FROM story_views v JOIN users u ON u.id=v.viewer WHERE v.story=?', mt[1])).map((x) => x.username));
  }

  // chat
  if (m === 'POST' && p === '/messages') {
    const { to, body } = await readJson(req);
    const t = await userByName(db, to);
    if (!t || !(await canInteract(db, me.id, t.id))) throw new HttpError(403, 'recipient must be a friend');
    if (typeof body !== 'string' || !body.trim() || body.length > 2000) throw new HttpError(400, 'message must be 1-2000 characters');
    const r = await db.run('INSERT INTO messages(sender, recipient, body, created) VALUES(?,?,?,?)', me.id, t.id, body, Date.now());
    await notify(env, ctx, db, t.id, 'message', { id: r.meta.last_row_id, from: me.username }, `New message from ${me.username}`);
    return json({ id: r.meta.last_row_id }, 201);
  }
  if (m === 'GET' && (mt = p.match(/^\/messages\/([a-z0-9_]+)$/))) {
    const t = await userByName(db, mt[1]);
    if (!t || !(await canInteract(db, me.id, t.id))) throw new HttpError(403, 'not friends');
    await db.run('UPDATE messages SET seen=? WHERE sender=? AND recipient=? AND seen IS NULL', Date.now(), t.id, me.id);
    const rows = await db.all('SELECT m.id, u.username AS "from", m.body, m.created FROM messages m JOIN users u ON u.id=m.sender WHERE (m.sender=? AND m.recipient=?) OR (m.sender=? AND m.recipient=?) ORDER BY m.id DESC LIMIT 200', me.id, t.id, t.id, me.id);
    return json(rows.reverse());
  }
  throw new HttpError(404, 'not found');
}

export default {
  async fetch(req, env, ctx) {
    try { return await handle(req, env, ctx); }
    catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e); return json({ error: 'internal error' }, 500);
    }
  },
  async scheduled(_evt, env, ctx) { ctx.waitUntil(sweep(env)); },
};
