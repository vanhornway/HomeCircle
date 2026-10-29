import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { CircleClient, type InvitePreview } from '@homecircle/core';
import { Button, ErrorText, Field, H1, LockNote, P, Screen } from '../components/ui';
import { addCircle, allClients, clientForCircle, draftClient, errorText } from '../lib/circle';
import { enterApp } from '../lib/nav';
import { updateSettings } from '../lib/storage';
import { currentSkin, isSkin, setSkin } from '../skins';
import { setPage } from '../companion/people';
import { useTheme } from '../theme';

export default function Join() {
  const t = useTheme();
  // Deep link: homecircle://join?server=…&i=…&s=…
  const params = useLocalSearchParams<{ server?: string; i?: string; s?: string }>();
  const [link, setLink] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [name, setName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);

  const openLink = async (value: string) => {
    setError(null);
    setBusy(true);
    try {
      const p = await draftClient().previewInvite(value.trim());
      const existing = clientForCircle(p.circleId);
      if (existing) throw new Error(`You’re already in ${existing.circle.name} on this phone.`);
      // An elder's invite switches the phone to her screens, with no way back:
      // only on a phone that's new, or already hers.
      if (p.companion && p.companion.skin !== 'full' && allClients().length && currentSkin() === 'full') {
        throw new Error(`This invite is for ${p.companion.name || 'an elder'}’s phone. Scan it there, on a phone that isn’t in a circle yet.`);
      }
      setLink(value.trim());
      setPreview(p);
      setScanning(false);
    } catch (e) {
      setError(errorText(e));
      handled.current = false;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!params.server || !params.i || !params.s) return;
    const deepLink = `homecircle://join?server=${encodeURIComponent(params.server)}&i=${params.i}&s=${params.s}`;
    const timer = setTimeout(() => openLink(deepLink), 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.server, params.i, params.s]);

  const join = async () => {
    if (!link) return;
    setBusy(true);
    setError(null);
    try {
      const first = allClients().length === 0;
      const client = draftClient();
      await client.joinWithInvite(link, { name });
      const elder = preview?.companion;
      if (elder) {
        await setPage(client.circleId!, elder.page);
        if (elder.skin && isSkin(elder.skin)) await setSkin(elder.skin);
      }
      await addCircle(client);
      if (first) {
        const info = await CircleClient.serverInfo(client.serverUrl!).catch(() => null);
        if (info) await updateSettings({ tileUrl: info.tileUrl, tileAttribution: info.tileAttribution });
        enterApp('/permissions');
      } else {
        enterApp();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (preview) {
    return (
      <Screen>
        <H1 style={{ marginTop: 12 }}>Join {preview.circleName || 'this circle'}</H1>
        <P muted style={{ marginTop: 8, marginBottom: 24 }}>
          {preview.invitedBy ? `${preview.invitedBy} invited you` : 'You’ve been invited'} to share locations and chat privately on{' '}
          {preview.serverUrl.replace(/^https?:\/\//, '')}.
        </P>
        {preview.companion ? (
          <P style={{ marginBottom: 16, fontWeight: '700' }}>
            Joining as {preview.companion.name}. This phone then shows the simple screens the family chose for her.
          </P>
        ) : (
          <Field label="Your name" value={name} onChangeText={setName} placeholder="What your family calls you" autoComplete="given-name" autoFocus />
        )}
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: agreed }}
          onPress={() => setAgreed((v) => !v)}
          style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start', padding: 14, borderRadius: 14, borderWidth: 1, borderColor: agreed ? t.brand : t.line, backgroundColor: agreed ? t.brandSoft : t.surface, marginBottom: 16 }}
        >
          <View
            style={{ width: 28, height: 28, borderRadius: 8, borderWidth: 2, borderColor: agreed ? t.brand : t.muted, backgroundColor: agreed ? t.brand : 'transparent', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}
          >
            {agreed ? <Text style={{ color: t.brandInk, fontWeight: '800', fontSize: 16 }}>✓</Text> : null}
          </View>
          <Text style={{ flex: 1, color: t.text, fontSize: 15, lineHeight: 21 }}>
            I agree that everyone in {preview.circleName || 'this circle'} can see where I am and can ask my phone for my current location at any
            time. If I pause sharing, they’ll see that I paused.
          </Text>
        </Pressable>
        <Button title="Join circle" variant="primary" loading={busy} disabled={(!name.trim() && !preview.companion) || !agreed} onPress={join} />
        <ErrorText>{error}</ErrorText>
        <LockNote>Your keys are created on this phone. Only people in this circle can see your location or messages.</LockNote>
      </Screen>
    );
  }

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
            openLink(data);
          }}
        />
        <View style={{ position: 'absolute', left: 20, right: 20, bottom: 48, gap: 12 }}>
          <Text style={{ color: '#fff', textAlign: 'center', fontSize: 16, fontWeight: '600' }}>
            {busy ? 'Checking invite…' : 'Point at the invite QR code'}
          </Text>
          {error ? <Text style={{ color: '#ffb4a6', textAlign: 'center' }}>{error}</Text> : null}
          <Button title="Cancel" onPress={() => setScanning(false)} />
        </View>
      </View>
    );
  }

  return (
    <Screen>
      <H1 style={{ marginTop: 12 }}>{allClients().length ? 'Join another circle' : 'Join your family'}</H1>
      <P muted style={{ marginTop: 8, marginBottom: 24 }}>
        Ask someone in the circle to open Settings → Invite, then scan their QR code or paste the link they send you.
      </P>
      <Button
        title="Scan invite QR code"
        variant="primary"
        onPress={async () => {
          const p = permission?.granted ? permission : await requestPermission();
          if (p.granted) {
            handled.current = false;
            setScanning(true);
          } else if (!p.canAskAgain) {
            Linking.openSettings();
          }
        }}
      />
      <Text style={{ color: t.muted, textAlign: 'center', marginVertical: 18 }}>or</Text>
      <Field label="Invite link" value={pasted} onChangeText={setPasted} placeholder="https://…/join#…" autoCapitalize="none" autoCorrect={false} />
      <Button title="Continue" loading={busy} disabled={!pasted.trim()} onPress={() => openLink(pasted)} />
      <ErrorText>{error}</ErrorText>
    </Screen>
  );
}
