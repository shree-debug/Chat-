// Local stand-ins for Cloudflare D1 / R2 / Durable Object so the Worker logic can be tested in plain Node.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(new URL('../migrations/', import.meta.url)).sort()) db.exec(fs.readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  return { prepare(sql) { const st = db.prepare(sql); return { bind: (...a) => ({
    first: async () => st.get(...a) ?? null,
    all: async () => ({ results: st.all(...a) }),
    run: async () => { const r = st.run(...a); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  }) }; }, raw: db };
}
export const mediaCount = (env) => env.DB.raw.prepare('SELECT COUNT(*) c FROM media').get().c;
export function makeR2_unused() {
  const m = new Map();
  return { m, async put(k, b) { m.set(k, b); }, async get(k) { const v = m.get(k); return v ? { arrayBuffer: async () => v } : null; }, async delete(keys) { for (const k of [].concat(keys)) m.delete(k); } };
}
export function makeHub() {
  const online = new Set(), sent = [];
  return { online, sent, idFromName: (n) => n, get: (id) => ({ fetch: async (_u, init) => { sent.push({ id, ...JSON.parse(init.body) }); return Response.json({ delivered: online.has(id) ? 1 : 0 }); } }) };
}
export function makeEnv(over = {}) {
  return { DB: makeD1(), HUB: makeHub(), JWT_SECRET: 'test-secret-1234567890-abcdef', ADMIN_TOKEN: 'admin-token-1234567', CONTACT_EMAIL: 'help@test.dev', RATE_AUTH: 1000, RATE_USER: 100000, ...over };
}
