import { useState } from 'react';
import { ActivityIndicator, Pressable, Share, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import type { FeatureId, Invite } from '@homecircle/core';
import { QRCode } from '../components/QRCode';
import { Button, ErrorText, Field, LockNote, P, Screen } from '../components/ui';
import { errorText, getClient } from '../lib/circle';
import { useTheme } from '../theme';

// An Elderly Companion invite lasts a week, so a helper near her has time to set up her phone.
const HOURS = 168;

/**
 * Give someone the Elderly Companion app: her name and which page this circle
 * is on her phone go sealed inside the invite, so nobody types on her phone.
 */
export default function CompanionInvite() {
  const t = useTheme();
  const client = getClient();
  const [name, setName] = useState('');
  const [page, setPage] = useState<'care' | 'grandkids'>('care');
  const [invite, setInvite] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sosOff = page === 'care' && !client.feature('sos');

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      // Her SOS and requests need SOS and the group chat on in a care circle.
      const needed: FeatureId[] = page === 'care' ? ['sos', 'groupChat'] : ['groupChat'];
      if (needed.some((id) => !client.feature(id))) await client.setFeatures(Object.fromEntries(needed.map((id) => [id, true])));
      setInvite(await client.createInvite({ hours: HOURS, companion: { name: name.trim(), page } }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const choice = (value: 'care' | 'grandkids', title: string, detail: string) => (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: page === value }}
      onPress={() => setPage(value)}
      style={{ flex: 1, padding: 12, borderRadius: 14, borderWidth: 2, borderColor: page === value ? t.brand : t.line, backgroundColor: page === value ? t.brandSoft : t.surface }}
    >
      <Text style={{ color: t.text, fontWeight: '700', fontSize: 16 }}>{title}</Text>
      <Text style={{ color: t.muted, fontSize: 13, marginTop: 2 }}>{detail}</Text>
    </Pressable>
  );

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: 'Elderly Companion' }} />
      {invite ? (
        <>
          <P muted style={{ marginBottom: 18 }}>
            On {name.trim()}’s phone, open the Elderly Companion app and tap Scan QR code. Or send the link to whoever is setting up her phone.
          </P>
          <View style={{ alignItems: 'center', padding: 16, backgroundColor: '#fff', borderRadius: 20, alignSelf: 'center' }}>
            <QRCode value={invite.link} size={220} />
          </View>
          <Text style={{ color: t.muted, textAlign: 'center', marginTop: 12, fontSize: 13 }}>
            Works once · expires {new Date(invite.expiresAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
          </Text>
          <View style={{ gap: 10, marginTop: 20 }}>
            <Button title="Share link" variant="primary" onPress={() => Share.share({ message: `Set up the Elderly Companion app for ${name.trim()}: ${invite.link}` })} />
            <Button title="Done" variant="ghost" onPress={() => setInvite(null)} />
          </View>
        </>
      ) : (
        <>
          <P muted style={{ marginBottom: 18 }}>
            They get a very simple app instead of HomeCircle: big tiles of the family, a button to ask for a call back, SOS, and later games. Location sharing works
            underneath, as for everyone else.
          </P>
          <Field label="Her name" value={name} onChangeText={setName} placeholder="As the family says it, e.g. Ammi" autoFocus />
          <Text style={{ color: t.muted, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8, marginLeft: 4 }}>This circle is her</Text>
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 18 }}>
            {choice('care', 'Care circle', 'Adult children. SOS, reminders until someone calls.')}
            {choice('grandkids', 'Grandkids', 'One notification, no reminders, no SOS.')}
          </View>
          {sosOff ? <P muted style={{ marginBottom: 12 }}>SOS is off in this circle. Making the invite turns it on, so her SOS reaches you.</P> : null}
          {busy ? <ActivityIndicator color={t.brand} /> : <Button title="Make invite" variant="primary" disabled={!name.trim()} onPress={create} />}
          <ErrorText>{error}</ErrorText>
        </>
      )}
      <LockNote>Her name travels inside the invite, end-to-end encrypted. The invite works once and lasts a week.</LockNote>
    </Screen>
  );
}
