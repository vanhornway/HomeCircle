import { useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { InvitePreview } from '@homecircle/core';
import { addCircle, allClients, clientForCircle, draftClient, errorText } from '../../lib/circle';
import { enterApp } from '../../lib/nav';
import { setPage } from '../../companion/people';
import { say } from '../../companion/lines';
import { C, URDU } from '../../companion/theme';

/**
 * Joining a circle (design 01). Usually done by whoever sets up her phone: scan
 * the QR code from HomeCircle's "Give someone the Elderly Companion app", or
 * paste the link. Her name comes with the invite, so nobody types it.
 */
export default function CompanionJoin() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [code, setCode] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  const open = async (value: string) => {
    setError(null);
    setBusy(true);
    try {
      const p = await draftClient().previewInvite(value.trim());
      const existing = clientForCircle(p.circleId);
      if (existing) throw new Error(`This phone is already in ${existing.circle.name}.`);
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

  const join = async () => {
    if (!link || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const first = allClients().length === 0;
      const client = draftClient();
      await client.joinWithInvite(link, { name });
      await setPage(client.circleId!, preview.companion?.page ?? 'care');
      await addCircle(client);
      say({ id: 'join_done', g: 'f' });
      enterApp(first ? '/permissions' : undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
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
            open(data);
          }}
        />
        <View style={{ position: 'absolute', left: 20, right: 20, bottom: 48, gap: 12 }}>
          <Text style={{ color: C.white, textAlign: 'center', fontSize: 20, fontWeight: '700' }}>{busy ? 'Checking the invite…' : 'Point at the QR code'}</Text>
          {error ? <Text style={{ color: '#ffb4a6', textAlign: 'center', fontSize: 16 }}>{error}</Text> : null}
          <BigButton title="Cancel" onPress={() => setScanning(false)} light />
        </View>
      </View>
    );
  }

  if (preview) {
    const her = preview.companion?.name;
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <ScrollView contentContainerStyle={{ padding: 24, gap: 18 }}>
          <Text style={{ color: C.ink, fontSize: 30, fontWeight: '800' }}>Join {preview.circleName || 'this circle'}</Text>
          <Text style={{ color: C.muted, fontSize: 18, lineHeight: 26 }}>
            {preview.invitedBy ? `${preview.invitedBy} invited ${her || 'you'}` : 'An invite'} to the family’s circle. Everyone in it will see where this phone is,
            and can ask it for its location at any time. Read this to her before joining.
          </Text>
          {her ? (
            <Text style={{ color: C.ink, fontSize: 22, fontWeight: '700' }}>Joining as {her}</Text>
          ) : (
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Her name, as the family says it"
              placeholderTextColor={C.muted}
              style={{ fontSize: 22, color: C.ink, borderWidth: 3, borderColor: C.ink, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 14, backgroundColor: C.white }}
            />
          )}
          <BigButton title="Join" onPress={join} busy={busy} disabled={!her && !name.trim()} />
          {error ? <Text style={{ color: C.red, fontSize: 16 }}>{error}</Text> : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <ScrollView contentContainerStyle={{ padding: 24, gap: 18, flexGrow: 1, justifyContent: 'center' }}>
        <Text style={{ color: C.ink, fontSize: 34, fontWeight: '800' }}>Elderly Companion</Text>
        <Text style={{ color: C.muted, fontSize: 20, lineHeight: 28 }}>Join your family’s circle to get started.</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Scan QR code"
          onPress={async () => {
            const p = permission?.granted ? permission : await requestPermission();
            if (p.granted) {
              handled.current = false;
              setScanning(true);
            } else if (!p.canAskAgain) {
              Linking.openSettings();
            }
          }}
          style={({ pressed }) => ({ minHeight: 132, borderRadius: 32, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center', gap: 4, opacity: pressed ? 0.85 : 1 })}
        >
          <Text style={{ color: C.white, fontSize: 26, fontWeight: '800' }}>Scan QR code</Text>
          <Text style={[URDU, { color: C.white, fontSize: 22, lineHeight: 44, textAlign: 'center' }]}>کیو آر کوڈ اسکین کریں</Text>
        </Pressable>
        <Text style={{ color: C.muted, fontSize: 18, textAlign: 'center' }}>or</Text>
        <TextInput
          value={code}
          onChangeText={setCode}
          placeholder="Invite link"
          placeholderTextColor={C.muted}
          autoCapitalize="none"
          autoCorrect={false}
          style={{ fontSize: 20, color: C.ink, borderWidth: 3, borderColor: C.ink, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 14, backgroundColor: C.white }}
        />
        <BigButton title="Join" onPress={() => open(code)} busy={busy} disabled={!code.trim()} />
        {error ? <Text style={{ color: C.red, fontSize: 16 }}>{error}</Text> : null}
        <Text style={{ color: C.muted, fontSize: 16, textAlign: 'center' }}>Everything else is set up by your family.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function BigButton({ title, onPress, busy, disabled, light }: { title: string; onPress: () => void; busy?: boolean; disabled?: boolean; light?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => ({ minHeight: 72, borderRadius: 24, backgroundColor: light ? C.white : C.ink, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : pressed ? 0.85 : 1 })}
    >
      {busy ? <ActivityIndicator color={light ? C.ink : C.white} /> : <Text style={{ color: light ? C.ink : C.white, fontSize: 22, fontWeight: '800' }}>{title}</Text>}
    </Pressable>
  );
}
