import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, Image, StyleSheet, Alert, StatusBar, KeyboardAvoidingView, Platform, SafeAreaView, ActivityIndicator, Linking } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as api from './src/api';

const C = { bg: '#0B0B12', card: '#171722', accent: '#7C5CFF', text: '#F4F4FA', mute: '#8A8AA3', err: '#FF5C7A' };
const fail = (e) => Alert.alert('ZYNQ', e.message || 'Something went wrong');
const Btn = ({ title, onPress, style, kind }) => (
  <TouchableOpacity onPress={onPress} style={[s.btn, kind === 'ghost' && s.ghost, style]}>
    <Text style={s.btnT}>{title}</Text>
  </TouchableOpacity>
);

function Auth({ onDone }) {
  const [mode, setMode] = useState('login');
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { const r = await (mode === 'login' ? api.login : api.register)(u.trim(), p); await api.setToken(r.token); onDone(r.username); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <KeyboardAvoidingView style={s.center} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Text style={s.logo}>ZYNQ</Text>
      <Text style={s.mute}>Snap it. Share it. Gone.</Text>
      <TextInput style={s.input} placeholder="username" placeholderTextColor={C.mute} autoCapitalize="none" value={u} onChangeText={setU} />
      <TextInput style={s.input} placeholder="password (8+ chars)" placeholderTextColor={C.mute} secureTextEntry value={p} onChangeText={setP} />
      {busy ? <ActivityIndicator color={C.accent} /> : <Btn title={mode === 'login' ? 'Log in' : 'Create account'} onPress={go} />}
      <TouchableOpacity onPress={() => setMode(mode === 'login' ? 'register' : 'login')}>
        <Text style={[s.mute, { marginTop: 16 }]}>{mode === 'login' ? 'New here? Sign up' : 'Have an account? Log in'}</Text>
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

function CameraTab({ friends }) {
  const [perm, ask] = useCameraPermissions();
  const cam = useRef(null);
  const [front, setFront] = useState(false);
  const [shot, setShot] = useState(null);
  if (!perm) return <View style={s.fill} />;
  if (!perm.granted) return <View style={s.center}><Text style={s.text}>ZYNQ needs the camera to take snaps.</Text><Btn title="Allow camera" onPress={ask} /></View>;
  if (shot) {
    const send = async (to) => { try { await api.sendSnap(to, shot); setShot(null); Alert.alert('Sent', `Snap sent to ${to}`); } catch (e) { fail(e); } };
    const story = async () => { try { await api.postStory(shot); setShot(null); Alert.alert('Posted to your story'); } catch (e) { fail(e); } };
    return (
      <View style={s.fill}>
        <Image source={{ uri: shot }} style={s.fill} resizeMode="cover" />
        <View style={s.sheet}>
          <Btn title="Add to My Story" onPress={story} />
          <Text style={[s.mute, { marginVertical: 8 }]}>Send to a friend:</Text>
          <FlatList horizontal data={friends} keyExtractor={(x) => x} ListEmptyComponent={<Text style={s.mute}>Add friends first</Text>}
            renderItem={({ item }) => <Btn title={item} onPress={() => send(item)} style={{ marginRight: 8 }} />} />
          <Btn title="Retake" kind="ghost" onPress={() => setShot(null)} style={{ marginTop: 12 }} />
        </View>
      </View>
    );
  }
  return (
    <View style={s.fill}>
      <CameraView ref={cam} style={s.fill} facing={front ? 'front' : 'back'} />
      <View style={s.shutterRow}>
        <Btn title="Flip" kind="ghost" onPress={() => setFront(!front)} />
        <TouchableOpacity style={s.shutter} onPress={async () => { try { const r = await cam.current.takePictureAsync({ quality: 0.7 }); const m = await ImageManipulator.manipulateAsync(r.uri, [{ resize: { width: 1080 } }], { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG }); setShot(m.uri); } catch (e) { fail(e); } }} />
        <View style={{ width: 70 }} />
      </View>
    </View>
  );
}

function SnapsTab({ items, refresh }) {
  const [view, setView] = useState(null);
  const open = async (id) => {
    try { setView(await api.snapMedia(id)); } catch (e) { fail(e); refresh(); }
  };
  if (view) return (
    <TouchableOpacity style={s.fill} activeOpacity={1} onPress={() => { setView(null); refresh(); }}>
      <Image source={{ uri: view }} style={s.fill} resizeMode="contain" />
      <Text style={s.hint}>Tap to close — this snap is now gone</Text>
    </TouchableOpacity>
  );
  return (
    <FlatList data={items} keyExtractor={(x) => x.id} onRefresh={refresh} refreshing={false}
      ListEmptyComponent={<Text style={[s.mute, s.pad]}>No new snaps. Pull to refresh.</Text>}
      renderItem={({ item }) => (
        <TouchableOpacity style={s.row} onPress={() => open(item.id)}>
          <Text style={s.text}>📸 {item.from}</Text><Text style={s.mute}>Tap to view once</Text>
        </TouchableOpacity>)} />
  );
}

function FriendsTab({ data, refresh, openChat }) {
  const [name, setName] = useState('');
  const add = async () => { try { await api.requestFriend(name.trim().toLowerCase()); setName(''); Alert.alert('Request sent'); } catch (e) { fail(e); } };
  const accept = async (u) => { try { await api.acceptFriend(u); refresh(); } catch (e) { fail(e); } };
  return (
    <View style={s.fill}>
      <View style={s.addRow}>
        <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} placeholder="add friend by username" placeholderTextColor={C.mute} autoCapitalize="none" value={name} onChangeText={setName} />
        <Btn title="Add" onPress={add} style={{ marginLeft: 8 }} />
      </View>
      <FlatList data={[...data.incoming.map((u) => ({ u, req: true })), ...data.friends.map((u) => ({ u }))]} keyExtractor={(x) => x.u + !!x.req}
        ListEmptyComponent={<Text style={[s.mute, s.pad]}>No friends yet.</Text>}
        renderItem={({ item }) => item.req ? (
          <View style={s.row}><Text style={s.text}>{item.u} wants to be friends</Text><Btn title="Accept" onPress={() => accept(item.u)} /></View>
        ) : (
          <TouchableOpacity style={s.row} onPress={() => openChat(item.u)}><Text style={s.text}>💬 {item.u}</Text></TouchableOpacity>
        )} />
    </View>
  );
}

function StoriesTab() {
  const [list, setList] = useState([]); const [img, setImg] = useState(null);
  const load = useCallback(() => api.stories().then(setList).catch(fail), []);
  useEffect(() => { load(); }, [load]);
  if (img) return (<TouchableOpacity style={s.fill} activeOpacity={1} onPress={() => setImg(null)}><Image source={{ uri: img }} style={s.fill} resizeMode="contain" /></TouchableOpacity>);
  return (
    <FlatList data={list} keyExtractor={(x) => x.id} onRefresh={load} refreshing={false}
      ListEmptyComponent={<Text style={[s.mute, s.pad]}>No stories right now.</Text>}
      renderItem={({ item }) => (
        <TouchableOpacity style={s.row} onPress={async () => { try { setImg(await api.storyImage(item.id)); } catch (e) { fail(e); } }}>
          <Text style={s.text}>⭕ {item.owner}</Text><Text style={s.mute}>{Math.max(0, Math.round((item.expires - Date.now()) / 3600000))}h left</Text>
        </TouchableOpacity>)} />
  );
}

function Chat({ peer, me, close }) {
  const [msgs, setMsgs] = useState([]); const [text, setText] = useState('');
  const load = useCallback(() => api.messages(peer).then(setMsgs).catch(() => {}), [peer]);
  useEffect(() => { load(); const off = api.onEvent((e) => { if ((e.event === 'message' && e.from === peer) || e.event === 'connected') load(); }); const t = setInterval(load, 20000); return () => { off(); clearInterval(t); }; }, [load, peer]);
  const send = async () => { if (!text.trim()) return; try { await api.sendMessage(peer, text.trim()); setText(''); load(); } catch (e) { fail(e); } };
  const doReport = (r) => async () => { try { await api.report(peer, r); Alert.alert('Thanks', 'Report sent. Our team will review it.'); } catch (e) { fail(e); } };
  const menu = () => Alert.alert(peer, 'What would you like to do?', [
    { text: 'Report', onPress: () => Alert.alert('Report ' + peer, 'Reason', [{ text: 'Harassment', onPress: doReport('Harassment') }, { text: 'Spam', onPress: doReport('Spam') }, { text: 'Inappropriate', onPress: doReport('Inappropriate content') }]) },
    { text: 'Block', style: 'destructive', onPress: async () => { try { await api.block(peer); close(); } catch (e) { fail(e); } } },
    { text: 'Cancel', style: 'cancel' }]);
  return (
    <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={s.header}><TouchableOpacity onPress={close}><Text style={s.text}>← Back</Text></TouchableOpacity><Text style={[s.text, { marginLeft: 16, fontWeight: '700' }]}>{peer}</Text><TouchableOpacity style={{ marginLeft: 'auto' }} onPress={menu}><Text style={s.text}>⋯</Text></TouchableOpacity></View>
      <FlatList data={msgs} keyExtractor={(x) => String(x.id)} contentContainerStyle={{ padding: 12 }}
        renderItem={({ item }) => (<View style={[s.bubble, item.from === me ? s.mine : s.theirs]}><Text style={s.text}>{item.body}</Text></View>)} />
      <View style={s.addRow}>
        <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} placeholder="Send a chat" placeholderTextColor={C.mute} value={text} onChangeText={setText} />
        <Btn title="Send" onPress={send} style={{ marginLeft: 8 }} />
      </View>
    </KeyboardAvoidingView>
  );
}

function SettingsTab({ logout }) {
  const [pw, setPw] = useState('');
  const del = () => Alert.alert('Delete account', 'This permanently deletes your account, messages and snaps.', [{ text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: async () => { try { await api.deleteAccount(pw); await logout(); } catch (e) { fail(e); } } }]);
  return (
    <View style={{ padding: 24 }}>
      <Text style={s.text}>Settings</Text>
      <Btn title="Privacy policy" kind="ghost" onPress={() => Linking.openURL(api.privacyUrl)} style={{ marginTop: 16 }} />
      <Btn title="Log out" kind="ghost" onPress={logout} style={{ marginTop: 12 }} />
      <Text style={[s.mute, { marginTop: 32 }]}>Delete account — enter your password:</Text>
      <TextInput style={[s.input, { marginTop: 8 }]} secureTextEntry placeholder="password" placeholderTextColor={C.mute} value={pw} onChangeText={setPw} />
      <Btn title="Delete my account" onPress={del} style={{ backgroundColor: C.err }} />
    </View>
  );
}

function Main({ me, logout }) {
  const [tab, setTab] = useState('camera');
  const [fr, setFr] = useState({ friends: [], incoming: [] });
  const [snaps, setSnaps] = useState([]);
  const [chat, setChat] = useState(null);
  const refresh = useCallback(async () => {
    try { setFr(await api.friends()); setSnaps(await api.inbox()); } catch (e) { if (e.status === 401) logout(); }
  }, [logout]);
  useEffect(() => { refresh(); const stopRt = api.connectRealtime(); const off = api.onEvent((e) => { if (e.event && e.event !== 'message') refresh(); }); api.registerPush(); const t = setInterval(refresh, 30000); return () => { stopRt(); off(); clearInterval(t); }; }, [refresh]);
  if (chat) return <Chat peer={chat} me={me} close={() => setChat(null)} />;
  const tabs = [['camera', '📷'], ['snaps', `👻${snaps.length ? ' ' + snaps.length : ''}`], ['friends', '👥'], ['stories', '⭕'], ['settings', '⚙️']];
  return (
    <View style={s.fill}>
      <View style={s.fill}>
        {tab === 'camera' && <CameraTab friends={fr.friends} />}
        {tab === 'snaps' && <SnapsTab items={snaps} refresh={refresh} />}
        {tab === 'friends' && <FriendsTab data={fr} refresh={refresh} openChat={setChat} />}
        {tab === 'stories' && <StoriesTab />}
        {tab === 'settings' && <SettingsTab logout={logout} />}
      </View>
      <View style={s.tabs}>
        {tabs.map(([k, label]) => (<TouchableOpacity key={k} style={s.tab} onPress={() => setTab(k)}><Text style={[s.tabT, tab === k && { color: C.accent }]}>{label}</Text></TouchableOpacity>))}
      </View>
    </View>
  );
}

export default function App() {
  const [me, setMe] = useState(null); const [ready, setReady] = useState(false);
  useEffect(() => { (async () => { try { if (await api.loadToken()) setMe((await fetch(api.API + '/me', { headers: api.authHeaders() }).then((r) => (r.ok ? r.json() : null)))?.username || null); } catch {} setReady(true); })(); }, []);
  const logout = useCallback(async () => { await api.setToken(null); setMe(null); }, []);
  if (!ready) return <View style={s.center}><ActivityIndicator color={C.accent} /></View>;
  return (
    <SafeAreaView style={s.fill}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      {me ? <Main me={me} logout={logout} /> : <Auth onDone={setMe} />}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg }, center: { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: 24 },
  logo: { color: C.accent, fontSize: 56, fontWeight: '900', letterSpacing: 6 }, text: { color: C.text, fontSize: 16 }, mute: { color: C.mute, fontSize: 14 },
  pad: { padding: 24, textAlign: 'center' }, input: { width: '100%', backgroundColor: C.card, color: C.text, borderRadius: 12, padding: 14, marginBottom: 12 },
  btn: { backgroundColor: C.accent, borderRadius: 24, paddingVertical: 12, paddingHorizontal: 20, alignItems: 'center' }, ghost: { backgroundColor: '#ffffff22' }, btnT: { color: '#fff', fontWeight: '700' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: C.card },
  addRow: { flexDirection: 'row', padding: 12, alignItems: 'center' }, header: { flexDirection: 'row', padding: 16, backgroundColor: C.card },
  bubble: { padding: 10, borderRadius: 14, marginBottom: 8, maxWidth: '80%' }, mine: { backgroundColor: C.accent, alignSelf: 'flex-end' }, theirs: { backgroundColor: C.card, alignSelf: 'flex-start' },
  tabs: { flexDirection: 'row', backgroundColor: C.card }, tab: { flex: 1, alignItems: 'center', padding: 14 }, tabT: { color: C.mute, fontSize: 20 },
  shutterRow: { position: 'absolute', bottom: 24, width: '100%', flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' },
  shutter: { width: 78, height: 78, borderRadius: 39, borderWidth: 5, borderColor: '#fff', backgroundColor: '#ffffff33' },
  sheet: { position: 'absolute', bottom: 0, width: '100%', backgroundColor: '#000000cc', padding: 16 }, hint: { position: 'absolute', bottom: 24, alignSelf: 'center', color: C.mute },
});
