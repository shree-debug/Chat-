import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';

export const API = Constants.expoConfig?.extra?.apiUrl || 'http://10.0.2.2:8080';
let token = null;

export const loadToken = async () => (token = await SecureStore.getItemAsync('zynq_token'));
export const setToken = async (t) => {
  token = t;
  if (t) await SecureStore.setItemAsync('zynq_token', t); else await SecureStore.deleteItemAsync('zynq_token');
};
export const authHeaders = () => ({ authorization: 'Bearer ' + token });

async function req(method, path, { json, body, mime } = {}) {
  const headers = token ? authHeaders() : {};
  if (json) headers['content-type'] = 'application/json';
  if (mime) headers['content-type'] = mime;
  const r = await fetch(API + path, { method, headers, body: json ? JSON.stringify(json) : body });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok) {
    const e = ct.includes('json') ? await r.json() : {};
    throw Object.assign(new Error(e.error || 'Request failed (' + r.status + ')'), { status: r.status });
  }
  return ct.includes('json') ? r.json() : r.blob();
}

const toDataUri = (blob) => new Promise((ok, no) => {
  const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = no; fr.readAsDataURL(blob);
});
const fileBlob = async (uri) => (await fetch(uri)).blob();

export const register = (username, password) => req('POST', '/auth/register', { json: { username, password } });
export const login = (username, password) => req('POST', '/auth/login', { json: { username, password } });
export const friends = () => req('GET', '/friends');
export const requestFriend = (username) => req('POST', '/friends/request', { json: { username } });
export const acceptFriend = (username) => req('POST', '/friends/accept', { json: { username } });
export const inbox = () => req('GET', '/snaps/inbox');
// View-once: fetch the bytes into memory as a data URI (server deletes the file after this call).
export const snapMedia = async (id) => toDataUri(await req('GET', `/snaps/${id}/media`));
export const sendSnap = async (to, uri, caption = '') =>
  req('POST', `/snaps?to=${encodeURIComponent(to)}&caption=${encodeURIComponent(caption)}`, { body: await fileBlob(uri), mime: 'image/jpeg' });
export const postStory = async (uri, caption = '') =>
  req('POST', `/stories?caption=${encodeURIComponent(caption)}`, { body: await fileBlob(uri), mime: 'image/jpeg' });
export const stories = () => req('GET', '/stories');
export const storyImage = async (id) => toDataUri(await req('GET', `/stories/${id}/media`));
export const messages = (u) => req('GET', `/messages/${encodeURIComponent(u)}`);
export const sendMessage = (to, body) => req('POST', '/messages', { json: { to, body } });

export const block = (username) => req('POST', '/blocks', { json: { username } });
export const report = (username, reason, kind = 'user', ref = '') => req('POST', '/reports', { json: { username, kind, ref, reason } });
export const deleteAccount = (password) => req('DELETE', '/me', { json: { password } });
export const privacyUrl = API + '/privacy';

// ---- realtime (WebSocket with auto-reconnect + keepalive) ----
const listeners = new Set(); let ws = null, stopped = true, retry = 0, pinger = null;
export const onEvent = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (d) => listeners.forEach((f) => f(d));
function open() {
  if (stopped || !token) return;
  ws = new WebSocket(API.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(token));
  ws.onopen = () => { retry = 0; emit({ event: 'connected' }); pinger = setInterval(() => { try { ws.send('ping'); } catch {} }, 30000); };
  ws.onmessage = (e) => { if (e.data === 'pong') return; try { emit(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => { clearInterval(pinger); if (!stopped) setTimeout(open, Math.min(30000, 1000 * 2 ** retry++)); };
  ws.onerror = () => {};
}
export function connectRealtime() { stopped = false; open(); return () => { stopped = true; clearInterval(pinger); try { ws && ws.close(); } catch {} }; }

// ---- push notifications (needs Firebase/EAS setup, see README; silently skipped if unavailable) ----
export async function registerPush() {
  try {
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') return;
    const t = await Notifications.getExpoPushTokenAsync();
    await req('POST', '/push-token', { json: { token: t.data } });
  } catch {}
}
