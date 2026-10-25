import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Avatar, H1, Screen } from '../../components/ui';
import { ServerBanner } from '../../components/ServerBanner';
import { RejoinBanner } from '../../components/RejoinBanner';
import { SettingsGroup, SettingsRow } from '../../components/SettingsKit';
import { CHIRP_NAMES } from '../../lib/chirp';
import { useCircles } from '../../lib/circle';
import { APP_VERSION, checkForUpdate, downloadUpdate, useNewerVersion } from '../../lib/updates';
import { buildNumber } from '../../../modules/hc-attention/src/HcAttentionModule';
import { useSettings } from '../../lib/storage';
import { useCircle } from '../../lib/useCircle';
import { useTheme } from '../../theme';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Settings: you at the top, then a short menu; each part has its own page. */
export default function SettingsTab() {
  const t = useTheme();
  const client = useCircle();
  const { clients } = useCircles();
  const settings = useSettings();
  const me = client.me;
  const circle = client.circle.name;
  const people = client.memberList().length;
  const agent = client.agent;
  const invited = client.agentInvited;
  const myChirp = settings.myChirp ?? me?.chirp ?? null;
  const newer = useNewerVersion();
  const build = buildNumber();
  const [checked, setChecked] = useState<'checking' | 'latest' | null>(null);

  return (
    <Screen>
      <H1 style={{ marginTop: 4 }}>Settings</H1>
      <ServerBanner style={{ marginTop: 14 }} />
      <RejoinBanner style={{ marginTop: 14 }} />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${me?.name ?? 'You'}, profile`}
        onPress={() => router.push('/settings/profile')}
        style={({ pressed }) => ({ marginTop: 18, flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: t.line, backgroundColor: pressed ? t.surface2 : t.surface })}
      >
        <Avatar name={me?.name ?? '?'} color={me?.color ?? t.muted} size={52} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontSize: 19, fontWeight: '700' }} numberOfLines={1}>
            {me?.name ?? 'You'}
          </Text>
          <Text style={{ color: t.muted, fontSize: 13 }} numberOfLines={1}>
            {me?.role && me.role !== 'member' ? `${me.role[0].toUpperCase()}${me.role.slice(1)} of ${circle}` : `In ${circle}`}
            {settings.sharing ? ' · sharing your location' : ' · sharing paused'}
          </Text>
        </View>
        <Text style={{ color: t.muted, fontSize: 22 }}>›</Text>
      </Pressable>

      <SettingsGroup title="Circle">
        <SettingsRow icon="👥" title={circle} detail={`${people === 1 ? '1 person' : `${people} people`}${client.isAdmin ? ' · invite, history, members' : ' · people, history, leave'}`} href="/settings/circle" />
        <SettingsRow icon="🏡" title="Your circles" detail={clients.length > 1 ? `${plural(clients.length, 'circle')} · switch, and how much each sees` : 'How much your circle sees, or join another'} href="/settings/circles" />
      </SettingsGroup>

      <SettingsGroup title="You">
        <SettingsRow icon="📍" title="Location sharing" detail={settings.sharing ? `On · about every ${settings.intervalMinutes} min · place alerts` : 'Paused · place alerts, most visited'} href="/settings/location" />
        <SettingsRow icon="🔔" title="Notifications" detail={settings.showPreviews ? 'Showing message text' : 'Hiding message text'} href="/settings/notifications" />
        <SettingsRow
          icon="🐦"
          title="Chirps & SOS"
          detail={`${myChirp ? `Your chirp: ${CHIRP_NAMES[myChirp]}` : 'Pick your chirp'} · SOS ${settings.sosThroughDnd ? 'rings through Do Not Disturb' : 'follows Do Not Disturb'}`}
          href="/settings/chirps"
        />
      </SettingsGroup>

      <SettingsGroup title="Helper">
        <SettingsRow
          icon="🤖"
          title={agent?.name ?? invited?.name ?? 'Circle agent'}
          detail={agent ? 'Memory, calendars, AI provider and budget' : invited ? 'Invited, waiting for it to join' : client.isAdmin ? 'Add an optional helper that remembers for your circle' : 'Not added to this circle'}
          href="/settings/agent"
        />
      </SettingsGroup>

      <SettingsGroup title="This phone">
        <SettingsRow icon="📱" title="This phone" detail="Setup check, diagnostics, server address" href="/settings/phone" />
        <SettingsRow
          icon="ℹ️"
          title={`HomeCircle ${APP_VERSION}${build ? ` · build ${build}` : ''}`}
          detail={newer ? `${newer} is out. Tap to download` : checked === 'checking' ? 'Checking…' : checked === 'latest' ? 'You have the latest version' : 'Tap to check for a new version'}
          onPress={() => {
            if (newer) return downloadUpdate();
            setChecked('checking');
            checkForUpdate({ force: true }).then((v) => setChecked(v ? null : 'latest'));
          }}
        />
      </SettingsGroup>
    </Screen>
  );
}
