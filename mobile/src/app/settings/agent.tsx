import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { Button } from '../../components/ui';
import { HelperAvatar } from '../../components/HelperAvatar';
import { HowThisWorks } from '../../components/HowThisWorks';
import { GroupBody, SettingsGroup, SettingsPage, SettingsRow } from '../../components/SettingsKit';
import { errorText } from '../../lib/circle';
import { downloadMemory } from '../../lib/memoryDownload';
import { useCircle } from '../../lib/useCircle';
import { useTheme } from '../../theme';
import { showSheet } from '../../lib/sheet';

/**
 * The circle's helper, as everyone uses it: what it remembers, a private chat
 * with it, a download of its memory. Admins add it here, and set it up
 * (provider, budget, name, removal) on its own page.
 */
export default function AgentSettingsPage() {
  const t = useTheme();
  const client = useCircle(['circle', 'members']);
  const agent = client.agent;
  const invited = client.agentInvited;
  const name = agent?.name ?? invited?.name ?? null;

  return (
    <SettingsPage title={name ?? 'Helper'}>
      {agent ? <AgentReady name={agent.name} /> : invited ? <Waiting name={invited.name} /> : client.isAdmin ? <AddAgent /> : <NotAdded />}
      <Text style={{ color: t.muted, fontSize: 14, lineHeight: 18, marginTop: 24, marginHorizontal: 4 }}>
        It can’t read your chats. It only sees what someone sends it.
      </Text>
      <HowThisWorks title={`What ${name ?? 'the helper'} can see`}>
        {[
          'It can’t read your chats, places or locations. It only sees what someone sends it: a question asked to it, a message you choose to Remember, or a file you send it.',
          'To answer, it sends the question and the notes it needs to the AI provider your admin picked, with people’s and places’ names swapped out.',
          'It never keeps passwords, door codes, or whole card, account or ID numbers: at most the last 4 digits.',
          'Health notes are just for the person who told it, unless they say to share it with the circle. What you tell it in a private chat stays yours the same way.',
          'Everything it keeps is in Memory, where you can change or delete it.',
        ]}
      </HowThisWorks>
    </SettingsPage>
  );
}

function NotAdded() {
  const t = useTheme();
  return (
    <SettingsGroup>
      <GroupBody>
        <Text style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>Your circle’s admins can add a helper that remembers dates, schedules and decisions for everyone, and answers questions like “when are the kids free next?”.</Text>
      </GroupBody>
    </SettingsGroup>
  );
}

function AddAgent() {
  const t = useTheme();
  const client = useCircle();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [host, setHost] = useState<{ available: boolean } | null>(null);
  useEffect(() => {
    client
      .agentHostStatus()
      .then(setHost)
      .catch(() => setHost({ available: false }));
  }, [client]);
  const add = () => {
    setBusy(true);
    client
      .setUpAgent({ name: name.trim() })
      .then((a) => showSheet(`${a?.name ?? name} is here`, `Everyone in the circle can ask it things now. Next, tap Set up ${a?.name ?? name} to pick its AI provider.`))
      .catch((e) => showSheet('Couldn’t add the helper', errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <SettingsGroup>
        <GroupBody>
          <Text style={{ color: t.text, fontSize: 17, fontWeight: '700' }}>A helper for your circle</Text>
          <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>
            It remembers dates, schedules and decisions for everyone, reads your school calendars, and answers questions like “when are the kids free next for 5 days?”. It’s optional: without it,
            everything works as it does now.
          </Text>
        </GroupBody>
      </SettingsGroup>
      {host && !host.available ? (
        <SettingsGroup title="First, on your server">
          <GroupBody>
            <Text style={{ color: t.text, fontSize: 14, lineHeight: 20 }}>
              The helper runs on your own server. Turn it on there: in Home Assistant, open the HomeCircle app’s Configuration and switch on run_agent; on Docker, Render or another host, set
              AGENT=true. Then come back here.
            </Text>
          </GroupBody>
        </SettingsGroup>
      ) : (
        <SettingsGroup title="Name it" footer="People ask it by name: “Jarvis, when is the dentist?”. Letters, numbers, spaces, - and _.">
          <GroupBody>
            <TextInput
              value={name}
              onChangeText={setName}
              maxLength={24}
              placeholder="e.g. Jarvis"
              placeholderTextColor={t.muted}
              accessibilityLabel="Helper’s name"
              style={{ color: t.text, fontSize: 17, minHeight: 48, borderBottomWidth: 1, borderBottomColor: t.line }}
            />
            <Button variant="primary" title={host ? 'Add to the circle' : 'Checking your server…'} disabled={!host || !name.trim()} loading={busy} onPress={add} />
            <Text style={{ color: t.muted, fontSize: 14 }}>Everyone in the circle is told when it’s added.</Text>
          </GroupBody>
        </SettingsGroup>
      )}
    </>
  );
}

function Waiting({ name }: { name: string }) {
  const t = useTheme();
  const client = useCircle();
  return (
    <SettingsGroup>
      <GroupBody>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <ActivityIndicator color={t.brand} />
          <Text style={{ color: t.text, fontSize: 15, flex: 1 }}>Waiting for {name} to join. This takes a few seconds when your server runs it.</Text>
        </View>
        {client.isAdmin ? <Button small title="Cancel" onPress={() => client.removeAgent().catch((e) => showSheet('Error', errorText(e)))} /> : null}
      </GroupBody>
    </SettingsGroup>
  );
}

function AgentReady({ name }: { name: string }) {
  const t = useTheme();
  const client = useCircle();

  // A zip of everything you can see of its memory, as an Obsidian vault.
  const [downloading, setDownloading] = useState(false);
  const download = () => {
    setDownloading(true);
    return downloadMemory(client)
      .then((out) => {
        if (out.missing.length) showSheet('Some files weren’t included', `These kept files couldn’t be read back: ${out.missing.join(', ')}. The README in the download lists them too.`);
      })
      .catch((e) => showSheet('Couldn’t download it', errorText(e)))
      .finally(() => setDownloading(false));
  };

  return (
    <>
      <SettingsGroup>
        <GroupBody gap={8}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <HelperAvatar size={44} />
            <Text style={{ color: t.text, fontSize: 17, fontWeight: '700', flex: 1 }}>{name}</Text>
          </View>
          <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>
            In the family chat, tap + and Ask {name}, or start with “{name},”. Long-press any message to Remember it.
          </Text>
        </GroupBody>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow icon="🧠" title={`What ${name} remembers`} detail="Search, change or delete notes and calendars" href="/agent-memory" />
        <SettingsRow
          icon="💬"
          title={`Chat with ${name} privately`}
          detail="Only you see it"
          onPress={() => client.agent && router.push({ pathname: '/conversation', params: { circle: client.circleId!, peer: client.agent.id } })}
        />
        <SettingsRow
          icon="⬇️"
          title="Download memory"
          detail={downloading ? 'Preparing your download…' : 'Everything you can see, as a zip that opens in Obsidian'}
          onPress={downloading ? undefined : download}
        />
      </SettingsGroup>

      {client.isAdmin ? (
        <SettingsGroup>
          <SettingsRow icon="settings" title={`Set up ${name}`} detail="AI provider, budget, name" href="/settings/agent-setup" />
        </SettingsGroup>
      ) : null}
    </>
  );
}
