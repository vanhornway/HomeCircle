import { useState } from 'react';
import { Alert, Text } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import type { MemberRecord } from '@homecircle/core';
import { GroupBody, SettingsGroup, SettingsPage, SettingsRow, ToggleRow } from '../components/SettingsKit';
import { Chips, GenderChips } from '../components/FamilyNames';
import { MemberPhoneGroup } from '../components/PhoneSettings';
import { errorText } from '../lib/circle';
import { useCircle } from '../lib/useCircle';
import { PROFILES, profileOf, profilePatch, skinStatus, type Profile } from '../skins/profile';
import { useTheme } from '../theme';

const EVENTS = ['members', 'records', 'circle', 'locations'] as const;
const SLEEP_FROM = ['21:00', '22:00', '23:00', '00:00'];
const SLEEP_TO = ['06:00', '07:00', '08:00', '09:00'];
const REMIND = [5, 10, 15, 30];
const INACTIVE = [12, 24, 48];
const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

/**
 * One elder's settings for this circle (design 13): her screens, her page, and
 * her setup. Admins change them; her phone picks them up by itself.
 */
export default function ElderSettings() {
  const t = useTheme();
  const { member } = useLocalSearchParams<{ member: string }>();
  const client = useCircle(EVENTS);
  const m = client.members.get(member);
  const rec = client.memberRecord(member);
  const [busy, setBusy] = useState(false);
  if (!m) return null;
  const page = rec?.page ?? 'care';
  const care = page === 'care';
  const admin = client.isAdmin;

  const save = (patch: Partial<Omit<MemberRecord, 'member' | 'by' | 'ts'>>) => {
    setBusy(true);
    client
      .setMemberRecord(member, patch)
      .catch((e) => Alert.alert('Couldn’t save', errorText(e)))
      .finally(() => setBusy(false));
  };
  const profile = profileOf(rec);
  const elder = profile !== 'full';
  const status = skinStatus(rec, client.locations.get(member), m.name);

  // Full ↔ elder ↔ grandkids, in any order and as often as needed. Their phone
  // follows by itself (while open, when it next connects, and by a silent push
  // when closed); the line under the choices says where it stands.
  const choose = (p: Profile) => {
    if (!admin || busy || p === profile) return;
    const go = () => {
      setBusy(true);
      (p === 'full' ? client.setMemberRecord(member, profilePatch('full')) : client.markElder(member, { page: profilePatch(p).page }))
        .catch((e) => Alert.alert('Couldn’t save', errorText(e)))
        .finally(() => setBusy(false));
    };
    if (p !== 'full' && m.role === 'admin') {
      Alert.alert(`Make ${m.name} an elder?`, `They stop being an admin. You can switch them back to the full app any time, but that won’t make them an admin again.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Switch', onPress: go },
      ]);
    } else go();
  };

  return (
    <SettingsPage title={m.name}>
      {/* The circle's owner always has the full app. */}
      {m.role !== 'owner' ? (
        <SettingsGroup
          title="Profile"
          footer="What their HomeCircle app shows."
          how="Their phone switches by itself, even if the app is closed, and you can change it as often as you like. Location sharing and everything else keeps working underneath."
        >
          <GroupBody>
            <Chips options={PROFILES.map((p) => ({ value: p.id, label: p.label }))} value={profile} onPick={(id) => choose(id as Profile)} />
            <Text style={{ color: t.muted, fontSize: 13 }}>{PROFILES.find((p) => p.id === profile)!.detail}</Text>
            {status.text ? <Text style={{ color: status.state === 'updated' ? t.brand : t.muted, fontSize: 13, fontWeight: status.state === 'updated' ? '700' : '400' }}>{status.text}</Text> : null}
          </GroupBody>
        </SettingsGroup>
      ) : null}

      <MemberPhoneGroup client={client} memberId={member} admin={admin} />

      {elder ? (
        <>
      <SettingsGroup title={`${m.name}’s tiles for this circle`} footer="Asking one person to call always stays available." how="Admins of each circle choose these for their own circle.">
        <ToggleRow
          title="Ring everyone"
          detail={(rec?.ringEveryone ?? care) ? 'On · one button asks the whole circle to call her' : 'Off · she asks one person at a time'}
          value={rec?.ringEveryone ?? care}
          onChange={(v) => save({ ringEveryone: v })}
          disabled={!admin || busy}
        />
        <ToggleRow
          title="Games"
          detail={(rec?.games ?? true) ? 'On · she can play with anyone in this circle (games are coming)' : 'Off · no Play a game on her tiles'}
          value={rec?.games ?? true}
          onChange={(v) => save({ games: v })}
          disabled={!admin || busy}
        />
        <SettingsRow icon="users" title="People on her tiles" detail="Order and the names she knows them by" href={{ pathname: '/elder-tiles', params: { member } }} />
      </SettingsGroup>

      <SettingsGroup title={`${m.name}’s setup`} footer="She never sees a settings screen." how="Changes download to her app automatically.">
        <GroupBody>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Sleep hours, her time</Text>
          <Text style={{ color: t.muted, fontSize: 13 }}>Nothing sounds on her phone then. She can always ask for a call or send an SOS.</Text>
          <Chips options={[{ value: '', label: 'None' }, ...SLEEP_FROM.map((v) => ({ value: v, label: `From ${clock(v)}` }))]} value={rec?.sleep?.from ?? ''} onPick={(v) => save({ sleep: v ? { from: v, to: rec?.sleep?.to ?? '07:00' } : null })} />
          {rec?.sleep ? <Chips options={SLEEP_TO.map((v) => ({ value: v, label: `To ${clock(v)}` }))} value={rec.sleep.to} onPick={(v) => save({ sleep: { from: rec.sleep!.from, to: v } })} /> : null}
        </GroupBody>
        {care ? (
          <GroupBody>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Reminders</Text>
            <Text style={{ color: t.muted, fontSize: 13 }}>Until an adult says “I’m calling you now”, with no time limit. Grandkids circles get one notification.</Text>
            <Chips options={REMIND.map((n) => ({ value: String(n), label: `Every ${n} min` }))} value={String(rec?.remindEvery ?? 10)} onPick={(v) => save({ remindEvery: Number(v) })} />
          </GroupBody>
        ) : null}
        <GroupBody>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Check in if inactive</Text>
          <Text style={{ color: t.muted, fontSize: 13 }}>The family is told quietly when her phone hasn’t been used for this long (coming soon).</Text>
          <Chips options={INACTIVE.map((n) => ({ value: String(n), label: `${n} hours` }))} value={String(rec?.inactiveHours ?? 24)} onPick={(v) => save({ inactiveHours: Number(v) })} />
        </GroupBody>
        <GroupBody>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Her language</Text>
          <Chips options={[{ value: 'ur', label: 'اردو Urdu' }]} value={rec?.lang ?? 'ur'} onPick={(v) => save({ lang: v })} />
          <Text style={{ color: t.muted, fontSize: 13 }}>What she hears and the few words she sees. More languages come as their recordings are made.</Text>
        </GroupBody>
        <GroupBody>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>She or he</Text>
          <Text style={{ color: t.muted, fontSize: 13 }}>Urdu verbs change with the person: “آپ جیت گئیں” for her, “آپ جیت گئے” for him.</Text>
          <GenderChips value={rec?.g ?? m.g ?? null} onPick={(g) => save({ g })} />
        </GroupBody>
      </SettingsGroup>

        </>
      ) : null}
      {!admin ? <Text style={{ color: t.muted, fontSize: 13, marginTop: 16 }}>Only the circle’s admins can change these.</Text> : null}
    </SettingsPage>
  );
}
