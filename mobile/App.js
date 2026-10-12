/**
 * SafeDrive - React Native app (JavaScript)
 * ------------------------------------------------------------
 * Same features as the website, talking to the same Python API:
 *   - live status + map, 60 s "Are you okay?" confirmation, contacts,
 *     history, personalization (theme + accent + confirm time).
 *
 * Setup (Expo is the easiest way to run it):
 *   npx create-expo-app safedrive-app
 *   cd safedrive-app
 *   npx expo install react-native-maps
 *   (replace App.js with this file)
 *   npx expo start
 *
 * IMPORTANT: set API_URL below to your computer's local IP address
 * (e.g. http://192.168.1.5:5000), NOT localhost - the phone cannot
 * reach "localhost" of your laptop.
 *
 * Later: add Firebase Cloud Messaging (expo-notifications or
 * @react-native-firebase/messaging) for push alerts, and put your
 * Google Maps API key in app.json for production maps.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Modal, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet,
  Switch, Text, TextInput, Vibration, View, useColorScheme,
} from 'react-native';
import MapView, { Marker } from 'react-native-maps';

const API_URL = 'http://192.168.1.5:5000'; // <-- change this
const PHONE_RE = /^\+?[0-9]{10,13}$/;
const ACCENTS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0d9488', '#475569'];
const STEPS = [15, 30, 45, 60, 90, 120, 180];

/* ---------------- API helper ---------------- */
async function api(method, path, body) {
  const res = await fetch(API_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

/* ---------------- Theme ---------------- */
function makeTheme(dark, accent) {
  return dark
    ? { dark, accent, bg: '#0d1017', card: '#161b25', card2: '#1c2230', text: '#eaeef6', muted: '#94a0b8', border: '#262d3d', safe: '#34d399', warn: '#fbbf24', danger: '#f87171' }
    : { dark, accent, bg: '#f3f5f9', card: '#ffffff', card2: '#f6f8fc', text: '#121722', muted: '#667085', border: '#e4e8f0', safe: '#15803d', warn: '#b45309', danger: '#dc2626' };
}

export default function App() {
  const system = useColorScheme();
  const [profile, setProfile] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [settings, setSettings] = useState({ confirm_seconds: 60, notify_sms: true, notify_call: true, notify_push: true, theme: 'auto', accent: '#2563eb' });
  const [history, setHistory] = useState([]);
  const [status, setStatus] = useState({ status: 'safe', event: null, seconds_left: 0, location: { lat: 18.5204, lng: 73.8567 } });
  const [online, setOnline] = useState(true);
  const [tab, setTab] = useState('home');

  const dark = settings.theme === 'auto' ? system === 'dark' : settings.theme === 'dark';
  const t = useMemo(() => makeTheme(dark, settings.accent), [dark, settings.accent]);
  const s = useMemo(() => makeStyles(t), [t]);

  /* ---- load everything + poll status every 2 s ---- */
  const loadAll = useCallback(async () => {
    try {
      const d = await api('GET', '/api/state');
      setProfile(d.profile); setContacts(d.contacts); setSettings(d.settings); setHistory(d.history);
      setOnline(true);
    } catch (e) { setOnline(false); }
  }, []);

  const pollRef = useRef(status.status);
  useEffect(() => { pollRef.current = status.status; }, [status.status]);

  useEffect(() => {
    loadAll();
    const id = setInterval(async () => {
      try {
        const st = await api('GET', '/api/status');
        setOnline(true);
        const before = pollRef.current;
        setStatus(st);
        if (before !== st.status) {
          if (st.status === 'confirming') Vibration.vibrate([0, 500, 300, 500, 300, 500]);
          if (st.status !== 'confirming') Vibration.cancel();
          if (before !== 'safe' || st.status === 'safe') loadAll();
        }
      } catch (e) { setOnline(false); }
    }, 2000);
    return () => clearInterval(id);
  }, [loadAll]);

  /* ---- local smooth countdown between polls ---- */
  const [left, setLeft] = useState(0);
  useEffect(() => { setLeft(status.seconds_left); }, [status.seconds_left, status.status]);
  useEffect(() => {
    if (status.status !== 'confirming') return undefined;
    const id = setInterval(() => setLeft((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(id);
  }, [status.status]);

  /* ---- actions ---- */
  const respond = async (answer) => {
    try { await api('POST', '/api/event/' + status.event.id + '/respond', { response: answer }); Vibration.cancel(); }
    catch (e) { Alert.alert('Could not send response', e.message); }
  };
  const simulateCrash = async () => {
    try {
      await api('POST', '/api/device/event', { device_id: 'APP-DEMO', accel_g: 6.2, tilt_deg: 72, vibration: 0.92, lat: status.location.lat + 0.004, lng: status.location.lng + 0.004 });
    } catch (e) { Alert.alert('Server not reachable', e.message); }
  };
  const resolve = async () => { try { await api('POST', '/api/event/resolve'); } catch (e) { Alert.alert('Error', e.message); } };
  const saveSettings = async (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    try { await api('PUT', '/api/settings', next); } catch (e) { Alert.alert('Could not save', e.message); }
  };

  const hero = {
    safe: { color: t.safe, title: 'Safe', text: 'No accident detected. Live monitoring is active.' },
    confirming: { color: t.warn, title: 'Confirming...', text: 'Impact detected. Waiting for your confirmation.' },
    accident: { color: t.danger, title: 'Accident detected', text: 'Emergency contacts have been alerted with the live location.' },
  }[status.status];

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} backgroundColor={t.bg} />
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.hello}>Hello, {profile ? profile.name.split(' ')[0] : '...'}</Text>
          <Text style={s.muted}>{profile ? profile.vehicle_name + ' - ' + profile.vehicle_number : 'Connecting...'}</Text>
        </View>
        <View style={[s.conn, { backgroundColor: online ? t.safe + '22' : t.danger + '22' }]}>
          <Text style={{ color: online ? t.safe : t.danger, fontWeight: '700', fontSize: 12 }}>{online ? 'Live' : 'Offline'}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={s.body}>
        {tab === 'home' && (
          <>
            <View style={[s.card, { borderTopColor: hero.color, borderTopWidth: 4 }]}>
              <Text style={s.eyebrow}>VEHICLE STATUS</Text>
              <Text style={[s.heroTitle, { color: hero.color }]}>{hero.title}</Text>
              <Text style={s.muted}>{hero.text}</Text>
              {status.status === 'safe' && (
                <Pressable style={[s.btn, { backgroundColor: t.danger, marginTop: 16 }]} onPress={simulateCrash}>
                  <Text style={s.btnText}>Simulate crash (demo)</Text>
                </Pressable>
              )}
              {status.status === 'accident' && (
                <Pressable style={[s.btn, s.btnGhost, { marginTop: 16 }]} onPress={resolve}>
                  <Text style={[s.btnText, { color: t.text }]}>Mark vehicle as safe</Text>
                </Pressable>
              )}
            </View>

            <View style={s.card}>
              <Text style={s.cardTitle}>Live location</Text>
              <MapView
                style={s.map}
                region={{ latitude: status.location.lat, longitude: status.location.lng, latitudeDelta: 0.02, longitudeDelta: 0.02 }}
              >
                <Marker coordinate={{ latitude: status.location.lat, longitude: status.location.lng }} pinColor={hero.color} title={profile ? profile.vehicle_name : 'Vehicle'} />
              </MapView>
              <Text style={[s.muted, { marginTop: 8 }]}>{status.location.lat.toFixed(4)}, {status.location.lng.toFixed(4)}</Text>
            </View>

            <View style={s.card}>
              <Text style={s.cardTitle}>Summary</Text>
              <View style={s.row3}>
                <Stat s={s} n={contacts.length} label="Contacts" />
                <Stat s={s} n={settings.confirm_seconds + 's'} label="Confirm window" />
                <Stat s={s} n={history.length} label="Past events" />
              </View>
            </View>
          </>
        )}

        {tab === 'contacts' && <ContactsTab s={s} t={t} contacts={contacts} reload={loadAll} />}

        {tab === 'history' && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Accident history</Text>
            {history.length === 0 && <Text style={s.muted}>No events recorded yet.</Text>}
            {history.map((e) => (
              <View key={e.id} style={s.item}>
                <View style={{ flex: 1 }}>
                  <Text style={s.itemTitle}>{e.outcome === 'alert_sent' ? 'Alert sent' : 'False alarm'}</Text>
                  <Text style={s.muted}>{new Date(e.time).toLocaleString()}</Text>
                  <Text style={s.muted}>{e.peak_g} g - {e.tilt} deg - {(e.alerts || []).length} contact(s) notified</Text>
                </View>
                <View style={[s.dot, { backgroundColor: e.outcome === 'alert_sent' ? t.danger : t.safe }]} />
              </View>
            ))}
          </View>
        )}

        {tab === 'settings' && (
          <SettingsTab s={s} t={t} profile={profile} settings={settings} saveSettings={saveSettings} reload={loadAll} />
        )}
      </ScrollView>

      <View style={s.tabbar}>
        {[['home', 'Home'], ['contacts', 'Contacts'], ['history', 'History'], ['settings', 'Settings']].map(([key, label]) => (
          <Pressable key={key} style={s.tab} onPress={() => setTab(key)}>
            <Text style={[s.tabText, tab === key && { color: t.accent, fontWeight: '800' }]}>{label}</Text>
            {tab === key && <View style={[s.tabLine, { backgroundColor: t.accent }]} />}
          </Pressable>
        ))}
      </View>

      {/* ---- "Are you okay?" confirmation ---- */}
      <Modal visible={status.status === 'confirming'} transparent animationType="fade" onRequestClose={() => {}}>
        <View style={s.overlay}>
          <View style={s.modal}>
            <Text style={[s.pill, { color: t.danger, backgroundColor: t.danger + '22' }]}>Possible accident detected</Text>
            <Text style={s.modalTitle}>Are you okay?</Text>
            <Text style={[s.muted, { textAlign: 'center' }]}>Your family will be alerted when the timer ends unless you confirm you are safe.</Text>
            <View style={[s.ring, { borderColor: left <= 10 ? t.danger : t.warn }]}>
              <Text style={s.ringNum}>{left}</Text>
              <Text style={s.muted}>seconds</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 10, width: '100%' }}>
              <Pressable style={[s.btn, { flex: 1, backgroundColor: t.safe }]} onPress={() => respond('safe')}>
                <Text style={[s.btnText, dark && { color: '#06251a' }]}>I am safe</Text>
              </Pressable>
              <Pressable style={[s.btn, { flex: 1, backgroundColor: t.danger }]} onPress={() => respond('help')}>
                <Text style={[s.btnText, dark && { color: '#2a0707' }]}>I need help</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/* ================= small pieces ================= */
function Stat({ s, n, label }) {
  return (
    <View style={s.stat}>
      <Text style={s.statNum}>{n}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

function ContactsTab({ s, t, contacts, reload }) {
  const [name, setName] = useState('');
  const [relation, setRelation] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');

  const add = async () => {
    const clean = phone.replace(/[\s\-()]/g, '');
    if (!name.trim()) return setError('Please enter a name.');
    if (!PHONE_RE.test(clean)) return setError('Enter a valid phone number (10-13 digits).');
    try {
      await api('POST', '/api/contacts', { name: name.trim(), relation: relation.trim() || 'Family', phone: clean });
      setName(''); setRelation(''); setPhone(''); setError(''); reload();
    } catch (e) { setError(e.message); }
  };
  const remove = (c) => Alert.alert('Remove contact', 'Remove ' + c.name + ' from emergency contacts?', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: async () => { try { await api('DELETE', '/api/contacts/' + c.id); reload(); } catch (e) { Alert.alert('Error', e.message); } } },
  ]);
  const primary = async (c) => { try { await api('PUT', '/api/contacts/' + c.id + '/primary'); reload(); } catch (e) { Alert.alert('Error', e.message); } };

  return (
    <>
      <View style={s.card}>
        <Text style={s.cardTitle}>Add family contact</Text>
        <TextInput style={s.input} placeholder="Name" placeholderTextColor={t.muted} value={name} onChangeText={setName} maxLength={40} />
        <TextInput style={s.input} placeholder="Relationship (e.g. Family)" placeholderTextColor={t.muted} value={relation} onChangeText={setRelation} maxLength={30} />
        <TextInput style={s.input} placeholder="+91 98765 43210" placeholderTextColor={t.muted} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
        {!!error && <Text style={{ color: t.danger, marginBottom: 8 }}>{error}</Text>}
        <Pressable style={[s.btn, { backgroundColor: t.accent }]} onPress={add}><Text style={s.btnText}>Add contact</Text></Pressable>
      </View>
      <View style={s.card}>
        <Text style={s.cardTitle}>Linked contacts ({contacts.length}/10)</Text>
        {contacts.length === 0 && <Text style={s.muted}>No contacts yet.</Text>}
        {contacts.map((c) => (
          <View key={c.id} style={s.item}>
            <View style={[s.avatar, { backgroundColor: t.accent }]}><Text style={{ color: '#fff', fontWeight: '800' }}>{c.name.charAt(0).toUpperCase()}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={s.itemTitle}>{c.name}{c.primary ? '  (Primary)' : ''}</Text>
              <Text style={s.muted}>{c.relation} - {c.phone}</Text>
            </View>
            {!c.primary && <Pressable onPress={() => primary(c)} style={s.mini}><Text style={s.miniText}>Primary</Text></Pressable>}
            <Pressable onPress={() => remove(c)} style={s.mini}><Text style={[s.miniText, { color: t.danger }]}>Delete</Text></Pressable>
          </View>
        ))}
      </View>
    </>
  );
}

function SettingsTab({ s, t, profile, settings, saveSettings, reload }) {
  const [form, setForm] = useState(profile || {});
  const [error, setError] = useState('');
  useEffect(() => { if (profile) setForm(profile); }, [profile]);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const saveProfile = async () => {
    const phone = String(form.phone || '').replace(/[\s\-()]/g, '');
    if (!String(form.name || '').trim()) return setError('Name is required.');
    if (!PHONE_RE.test(phone)) return setError('Enter a valid phone number.');
    try { await api('PUT', '/api/profile', { ...form, phone }); setError(''); reload(); Alert.alert('Saved', 'Profile updated.'); }
    catch (e) { setError(e.message); }
  };

  return (
    <>
      <View style={s.card}>
        <Text style={s.cardTitle}>Owner & vehicle</Text>
        {[['name', 'Your name'], ['phone', 'Your phone'], ['vehicle_name', 'Vehicle nickname'], ['vehicle_number', 'Vehicle number'], ['vehicle_model', 'Vehicle model']].map(([k, label]) => (
          <TextInput key={k} style={s.input} placeholder={label} placeholderTextColor={t.muted} value={String(form[k] || '')} onChangeText={set(k)} />
        ))}
        {!!error && <Text style={{ color: t.danger, marginBottom: 8 }}>{error}</Text>}
        <Pressable style={[s.btn, { backgroundColor: t.accent }]} onPress={saveProfile}><Text style={s.btnText}>Save profile</Text></Pressable>
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Safety confirmation</Text>
        <Text style={[s.muted, { marginBottom: 10 }]}>Time you get to tap "I am safe" before family is alerted.</Text>
        <View style={s.chipRow}>
          {STEPS.map((sec) => (
            <Pressable key={sec} onPress={() => saveSettings({ confirm_seconds: sec })}
              style={[s.chip, settings.confirm_seconds === sec && { backgroundColor: t.accent, borderColor: t.accent }]}>
              <Text style={[s.chipText, settings.confirm_seconds === sec && { color: '#fff' }]}>{sec}s</Text>
            </Pressable>
          ))}
        </View>
        {[['notify_sms', 'Send SMS to family'], ['notify_call', 'Place automatic call'], ['notify_push', 'Send app notification']].map(([k, label]) => (
          <View key={k} style={s.switchRow}>
            <Text style={{ color: t.text, fontSize: 15 }}>{label}</Text>
            <Switch value={!!settings[k]} onValueChange={(v) => saveSettings({ [k]: v })} trackColor={{ true: t.accent }} />
          </View>
        ))}
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Personalize</Text>
        <View style={s.chipRow}>
          {['auto', 'light', 'dark'].map((m) => (
            <Pressable key={m} onPress={() => saveSettings({ theme: m })}
              style={[s.chip, settings.theme === m && { backgroundColor: t.accent, borderColor: t.accent }]}>
              <Text style={[s.chipText, settings.theme === m && { color: '#fff' }]}>{m[0].toUpperCase() + m.slice(1)}</Text>
            </Pressable>
          ))}
        </View>
        <View style={[s.chipRow, { marginTop: 14 }]}>
          {ACCENTS.map((c) => (
            <Pressable key={c} onPress={() => saveSettings({ accent: c })}
              style={[s.swatch, { backgroundColor: c }, settings.accent === c && { borderColor: t.text, borderWidth: 3 }]} />
          ))}
        </View>
      </View>
    </>
  );
}

/* ================= styles ================= */
function makeStyles(t) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg, paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 },
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14 },
    hello: { color: t.text, fontSize: 22, fontWeight: '800' },
    muted: { color: t.muted, fontSize: 13 },
    conn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99 },
    body: { padding: 16, paddingBottom: 24, gap: 14 },
    card: { backgroundColor: t.card, borderRadius: 18, padding: 18, borderWidth: 1, borderColor: t.border },
    cardTitle: { color: t.text, fontSize: 16, fontWeight: '700', marginBottom: 12 },
    eyebrow: { color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
    heroTitle: { fontSize: 34, fontWeight: '800', marginVertical: 6 },
    btn: { paddingVertical: 14, borderRadius: 14, alignItems: 'center' },
    btnGhost: { borderWidth: 1, borderColor: t.border },
    btnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
    map: { height: 220, borderRadius: 14 },
    row3: { flexDirection: 'row', gap: 10 },
    stat: { flex: 1, backgroundColor: t.card2, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: t.border },
    statNum: { color: t.text, fontSize: 20, fontWeight: '800' },
    statLabel: { color: t.muted, fontSize: 11, marginTop: 2, textAlign: 'center' },
    input: { backgroundColor: t.card2, borderWidth: 1, borderColor: t.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: t.text, marginBottom: 10, fontSize: 15 },
    item: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.card2, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: t.border },
    itemTitle: { color: t.text, fontWeight: '700', fontSize: 15 },
    avatar: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
    mini: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, borderWidth: 1, borderColor: t.border, backgroundColor: t.card },
    miniText: { color: t.text, fontSize: 12, fontWeight: '700' },
    dot: { width: 12, height: 12, borderRadius: 6 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 99, borderWidth: 1, borderColor: t.border, backgroundColor: t.card2 },
    chipText: { color: t.text, fontWeight: '700', fontSize: 13 },
    swatch: { width: 34, height: 34, borderRadius: 17, borderWidth: 2, borderColor: t.card },
    switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
    tabbar: { flexDirection: 'row', backgroundColor: t.card, borderTopWidth: 1, borderTopColor: t.border, paddingBottom: Platform.OS === 'ios' ? 16 : 0 },
    tab: { flex: 1, alignItems: 'center', paddingVertical: 14 },
    tabText: { color: t.muted, fontSize: 13, fontWeight: '600' },
    tabLine: { position: 'absolute', top: 0, height: 3, width: 28, borderRadius: 2 },
    overlay: { flex: 1, backgroundColor: 'rgba(8,10,16,0.75)', justifyContent: 'center', padding: 20 },
    modal: { backgroundColor: t.card, borderRadius: 24, padding: 24, alignItems: 'center', gap: 12 },
    pill: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 99, fontWeight: '700', fontSize: 13, overflow: 'hidden' },
    modalTitle: { color: t.text, fontSize: 28, fontWeight: '800' },
    ring: { width: 150, height: 150, borderRadius: 75, borderWidth: 9, alignItems: 'center', justifyContent: 'center', marginVertical: 6 },
    ringNum: { color: t.text, fontSize: 46, fontWeight: '800' },
  });
}
