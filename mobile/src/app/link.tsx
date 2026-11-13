// Sign in on a computer: the web app (your server's page) shows a QR code.
// Scan it here, and that browser is signed in as you, in this circle: your
// phone seals the circle's keys to the browser's one-time key, so the server
// only passes them on. The browser gets its own sign-in, listed here to sign
// out. Also opened by the code itself (homecircle://link?…) from the camera.
import { useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { browserLinkUrl, normalizeServerUrl, parseBrowserLink, type BrowserLink, type BrowserSession, type CircleClient } from '@homecircle/core';
import { Button, ErrorText, P } from '../components/ui';
import { GroupBody, SettingsGroup, SettingsPage } from '../components/SettingsKit';
import { errorText, useCircles } from '../lib/circle';
import { confirm, notice } from '../lib/sheet';
import { timeAgo } from '../lib/useCircle';
import { useTheme } from '../theme';

export default function LinkBrowser() {
  const t = useTheme();
  const { clients, active } = useCircles();
  const params = useLocalSearchParams<{ server?: string; l?: string; k?: string; n?: string }>();
  const fromCamera = params.server && params.l && params.k ? parseBrowserLink(browserLinkUrl(params.server, params.l, params.k, params.n ?? '')) : null;
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const handled = useRef(false);
  const [link, setLink] = useState<BrowserLink | null>(fromCamera);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [sessions, setSessions] = useState<{ client: CircleClient; list: BrowserSession[] }[]>([]);

  // The circles on the browser's server: it can be signed in to one of them.
  const sameServer = (l: BrowserLink) => clients.filter((c) => c.account && normalizeServerUrl(c.account.server) === l.server);

  const load = useCallback(() => {
    Promise.all(
      clients.filter((c) => c.account).map(async (c) => ({ client: c, list: await c.browserSessions().catch(() => [] as BrowserSession[]) })),
    ).then((all) => setSessions(all.filter((x) => x.list.length)));
  }, [clients]);
  useFocusEffect(load);

  const use = (text: string) => {
    const l = parseBrowserLink(text);
    if (!l) {
      setError('That isn’t a HomeCircle sign-in code. On the computer, open your HomeCircle page and choose Sign in with your phone.');
      return false;
    }
    if (!sameServer(l).length) {
      setError(`That page is on ${l.server.replace(/^https?:\/\//, '')}, and none of your circles are on that server.`);
      return false;
    }
    setError(null);
    setDone(null);
    setLink(l);
    return true;
  };

  const signIn = async (c: CircleClient) => {
    if (!link) return;
    setBusy(true);
    setError(null);
    try {
      await c.linkBrowser(link);
      setDone(`${link.label} is signed in to ${c.circle.name} as ${c.me?.name ?? 'you'}.`);
      setLink(null);
      load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async (c: CircleClient, s: BrowserSession) => {
    if (!(await confirm(`Sign out ${s.label}?`, `It’s signed out of ${c.circle.name} at once, and its copy of the keys stops working here.`, 'Sign out', { destructive: true }))) return;
    try {
      await c.signOutBrowser(s.id);
      load();
    } catch (e) {
      notice('Couldn’t sign it out', errorText(e));
    }
  };

  if (scanning && permission?.granted) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (handled.current) return;
            handled.current = true;
            if (use(data)) setScanning(false);
            else setTimeout(() => (handled.current = false), 1500);
          }}
        />
        <View style={{ position: 'absolute', left: 20, right: 20, bottom: 48, gap: 12 }}>
          <Text style={{ color: '#fff', textAlign: 'center', fontSize: 16, fontWeight: '600' }}>Point at the code on the computer’s screen</Text>
          {error ? <Text style={{ color: '#ffb4a6', textAlign: 'center' }}>{error}</Text> : null}
          <Button title="Cancel" onPress={() => setScanning(false)} />
        </View>
      </View>
    );
  }

  const choices = link ? sameServer(link) : [];
  return (
    <SettingsPage title="Sign in on a computer">
      {link ? (
        <SettingsGroup title="Sign in this browser?" footer="Only scan a code you see on your own computer, just now. That browser can then read and write in the circle as you, until you sign it out here.">
          <GroupBody>
            <Text style={{ color: t.text, fontSize: 19, fontWeight: '700' }}>{link.label}</Text>
            <P muted>On {link.server.replace(/^https?:\/\//, '')}. Check the computer shows the same name.</P>
            {choices.map((c) => (
              <Button
                key={c.accountKey}
                variant={c === active || choices.length === 1 ? 'primary' : 'default'}
                title={choices.length > 1 ? `Sign in to ${c.circle.name}` : `Sign in as ${c.me?.name ?? 'you'}`}
                loading={busy}
                onPress={() => signIn(c)}
              />
            ))}
            <Button variant="ghost" title="Cancel" onPress={() => setLink(null)} />
          </GroupBody>
        </SettingsGroup>
      ) : (
        <SettingsGroup title="Use HomeCircle on a computer" footer="Your keys go to that browser sealed so only it can open them; your server just passes them on.">
          <GroupBody>
            {done ? <Text style={{ color: t.brand, fontSize: 16, fontWeight: '700' }}>✓ {done}</Text> : null}
            <P muted>On the computer, open your HomeCircle page and choose Sign in with your phone. Then scan the code it shows.</P>
            <Button
              variant="primary"
              title="Scan the code"
              onPress={async () => {
                setError(null);
                handled.current = false;
                const p = permission?.granted ? permission : await requestPermission();
                if (p.granted) setScanning(true);
                else notice('Camera is off for HomeCircle', 'Turn it on in the phone’s Settings to scan the code.');
              }}
            />
          </GroupBody>
        </SettingsGroup>
      )}
      {error ? <View style={{ marginTop: 10 }}><ErrorText>{error}</ErrorText></View> : null}

      {sessions.map(({ client: c, list }) => (
        <SettingsGroup key={c.accountKey} title={clients.length > 1 ? `Browsers in ${c.circle.name}` : 'Browsers signed in as you'}>
          {list.map((s) => (
            <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderTopWidth: 1, borderTopColor: t.line }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{s.label}</Text>
                <Text style={{ color: t.muted, fontSize: 14 }}>Signed in {timeAgo(s.createdAt)}{s.lastSeenAt ? ` · last used ${timeAgo(s.lastSeenAt)}` : ''}</Text>
              </View>
              <Button small variant="danger" title="Sign out" onPress={() => signOut(c, s)} />
            </View>
          ))}
        </SettingsGroup>
      ))}
    </SettingsPage>
  );
}
