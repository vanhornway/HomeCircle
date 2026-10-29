import { useState } from 'react';
import { ActivityIndicator, Pressable, Share, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import type { FeatureId, Invite } from '@homecircle/core';
import { QRCode } from '../components/QRCode';
import { AgeConfirm, Button, ErrorText, Field, LockNote, P, Screen } from '../components/ui';
import { errorText, getClient } from '../lib/circle';
import { SKINS, type SkinId } from '../skins';
import { useTheme } from '../theme';

// An Elderly Companion invite lasts a week, so a helper near her has time to set up her phone.
const HOURS = 168;

/**
 * Mark someone as an elder (design 13): her name, which page this circle is
 * on her phone and which skin it shows go sealed inside the invite, so
 * nobody types on her phone and it switches as soon as it joins.
 */
export default function CompanionInvite() {
  const t = useTheme();
  const client = getClient();
  const [name, setName] = useState('');
  const [page, setPage] = useState<'care' | 'grandkids'>('care');
  const [skin, setSkin] = useState<SkinId>('elderly');
  const [adult, setAdult] = useState(false);
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
      setInvite(await client.createInvite({ hours: HOURS, companion: { name: name.trim(), page, skin } }));
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
      <Stack.Screen options={{ headerShown: true, title: 'Mark someone as an elder' }} />
      {invite ? (
        <>
          <P muted style={{ marginBottom: 18 }}>
            Install HomeCircle on {name.trim()}’s phone, tap “Join my family” and scan this code. Or send the link to whoever is setting up her phone. Once joined, it shows {SKINS[skin].label === 'Full app' ? 'the full app' : 'the simple screens'}.
          </P>
          <View style={{ alignItems: 'center', padding: 16, backgroundColor: '#fff', borderRadius: 20, alignSelf: 'center' }}>
            <QRCode value={invite.link} size={220} />
          </View>
          <Text style={{ color: t.muted, textAlign: 'center', marginTop: 12, fontSize: 13 }}>
            Works once · expires {new Date(invite.expiresAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
          </Text>
          <View style={{ gap: 10, marginTop: 20 }}>
            <Button title="Share link" variant="primary" onPress={() => Share.share({ message: `Set up HomeCircle for ${name.trim()}: ${invite.link}` })} />
            <Button title="Done" variant="ghost" onPress={() => setInvite(null)} />
          </View>
        </>
      ) : (
        <>
          <P muted style={{ marginBottom: 18 }}>
            Choose which skin their HomeCircle app shows. The Elderly Companion screens are big photo tiles, Ring everyone, SOS and games; there’s no way back to
            the full app from their phone. Location sharing and everything else keeps working underneath.
          </P>
          <Field label="Her name" value={name} onChangeText={setName} placeholder="As the family says it, e.g. Ammi" autoFocus />
          <Text style={{ color: t.muted, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8, marginLeft: 4 }}>This circle is her</Text>
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 18 }}>
            {choice('care', 'Care circle', 'Adult children. SOS, reminders until someone calls.')}
            {choice('grandkids', 'Grandkids', 'One notification, no reminders, no SOS.')}
          </View>
          <Text style={{ color: t.muted, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8, marginLeft: 4 }}>Skin</Text>
          <View style={{ gap: 10, marginBottom: 18 }}>
            {(Object.keys(SKINS) as SkinId[]).map((id) => (
              <Pressable
                key={id}
                accessibilityRole="radio"
                accessibilityState={{ checked: skin === id }}
                onPress={() => setSkin(id)}
                style={{ padding: 12, borderRadius: 14, borderWidth: 2, borderColor: skin === id ? t.brand : t.line, backgroundColor: skin === id ? t.brandSoft : t.surface }}
              >
                <Text style={{ color: t.text, fontWeight: '700', fontSize: 16 }}>{SKINS[id].label}</Text>
                <Text style={{ color: t.muted, fontSize: 13, marginTop: 2 }}>{SKINS[id].detail}</Text>
              </Pressable>
            ))}
          </View>
          <AgeConfirm value={adult} onChange={setAdult} />
          {sosOff ? <P muted style={{ marginBottom: 12 }}>SOS is off in this circle. Making the invite turns it on, so her SOS reaches you.</P> : null}
          {busy ? <ActivityIndicator color={t.brand} /> : <Button title="Make invite" variant="primary" disabled={!name.trim() || !adult} onPress={create} />}
          <ErrorText>{error}</ErrorText>
        </>
      )}
      <LockNote>Her name travels inside the invite, end-to-end encrypted. The invite works once and lasts a week.</LockNote>
    </Screen>
  );
}
