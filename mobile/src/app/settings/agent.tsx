import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Share, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Button } from '../../components/ui';
import { GroupBody, SettingsGroup, SettingsPage, SettingsRow } from '../../components/SettingsKit';
import { errorText } from '../../lib/circle';
import { useCircle } from '../../lib/useCircle';
import { useTheme } from '../../theme';

type ModelChoice = { id: string; name: string; inUsd: number; outUsd: number };
type AgentSettings = {
  name: string;
  provider: { provider: string; model: string; baseUrl: string | null; inUsd: number; outUsd: number; keySet: boolean } | null;
  budgetUsd: number;
  providers: Record<string, { name: string; models: ModelChoice[] | null; suggested: string | null }>;
};
type Usage = { total: number; budgetUsd: number; byMember: { name: string; usd: number }[] | null };

const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`;

/** The circle's agent: add it, name it, its AI provider and budget, its memory, and removing it. */
export default function AgentSettingsPage() {
  const t = useTheme();
  const client = useCircle(['circle', 'members']);
  const agent = client.agent;
  const invited = client.agentInvited;
  const title = agent?.name ?? invited?.name ?? 'Circle agent';

  return (
    <SettingsPage title={title}>
      {agent ? <AgentReady name={agent.name} /> : invited ? <Waiting name={invited.name} /> : client.isAdmin ? <AddAgent /> : <NotAdded />}
      <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17, marginTop: 24, marginHorizontal: 4 }}>
        The agent can’t read your chats. It only sees what someone sends it: a question with its name, or a message you choose to Remember. Questions and the notes used to answer them go to the
        AI provider your admin picked, with names swapped out.
      </Text>
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
      .then((a) => Alert.alert(`${a?.name ?? name} is here`, 'Everyone in the circle can now ask it things. Next, add an AI provider below.'))
      .catch((e) => Alert.alert('Couldn’t add the agent', errorText(e)))
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
              The agent runs on your own server. Turn it on there: in Home Assistant, open the HomeCircle app’s Configuration and switch on run_agent; on Docker, Render or another host, set
              AGENT=true. Then come back here.
            </Text>
          </GroupBody>
        </SettingsGroup>
      ) : (
        <SettingsGroup title="Name it" footer="People call it by this name: “/Jarvis when is the dentist?”. Letters, numbers, spaces, - and _.">
          <GroupBody>
            <TextInput
              value={name}
              onChangeText={setName}
              maxLength={24}
              placeholder="e.g. Jarvis"
              placeholderTextColor={t.muted}
              accessibilityLabel="Agent name"
              style={{ color: t.text, fontSize: 17, minHeight: 48, borderBottomWidth: 1, borderBottomColor: t.line }}
            />
            <Button variant="primary" title={host ? 'Add to the circle' : 'Checking your server…'} disabled={!host || !name.trim()} loading={busy} onPress={add} />
            <Text style={{ color: t.muted, fontSize: 13 }}>Everyone in the circle is told when it’s added.</Text>
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
        {client.isAdmin ? <Button small title="Cancel" onPress={() => client.removeAgent().catch((e) => Alert.alert('Error', errorText(e)))} /> : null}
      </GroupBody>
    </SettingsGroup>
  );
}

function AgentReady({ name }: { name: string }) {
  const t = useTheme();
  const client = useCircle();
  const admin = client.isAdmin;
  const [s, setS] = useState<AgentSettings | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    client
      .agentRpc<AgentSettings>('settings')
      .then(setS)
      .catch((e) => setError(errorText(e)));
    client
      .agentRpc<Usage>('usage')
      .then(setUsage)
      .catch(() => {});
  }, [client]);
  useFocusEffect(load);

  const remove = () =>
    Alert.alert(`Remove ${name}?`, 'Its memory is deleted for good. You can download a copy first.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Download first',
        onPress: () =>
          client
            .agentRpc<Record<string, string>>('export')
            .then((files) =>
              Share.share({
                title: `${name} memory`,
                message: Object.entries(files)
                  .map(([path, text]) => `<!-- ${path} -->\n${text}`)
                  .join('\n\n'),
              }),
            )
            .catch((e) => Alert.alert('Couldn’t download it', errorText(e))),
      },
      { text: 'Remove', style: 'destructive', onPress: () => client.removeAgent().catch((e) => Alert.alert('Couldn’t remove it', errorText(e))) },
    ]);

  return (
    <>
      <SettingsGroup>
        <GroupBody gap={4}>
          <Text style={{ color: t.text, fontSize: 17, fontWeight: '700' }}>🤖 {name}</Text>
          <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>
            Ask it in any chat with “/{name} …” or the 🤖 button. Long-press a message and tap Remember to keep it. Send it a calendar link or PDF to add a calendar.
            {client.isAdmin ? ` Admins: “/${name}/dream” sorts and tidies everything it remembers.` : ''}
          </Text>
        </GroupBody>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow icon="🧠" title={`What ${name} remembers`} detail="Search, browse, edit or delete notes and calendars" href="/agent-memory" />
        <SettingsRow
          icon="💬"
          title={`Chat with ${name} privately`}
          detail="Only you see it; what you tell it stays private unless you say “share with the circle”"
          onPress={() => client.agent && router.push({ pathname: '/conversation', params: { circle: client.circleId!, peer: client.agent.id } })}
        />
      </SettingsGroup>

      {error ? (
        <SettingsGroup>
          <GroupBody>
            <Text style={{ color: t.danger, fontSize: 14 }}>{error}</Text>
            <Button small title="Try again" onPress={load} />
          </GroupBody>
        </SettingsGroup>
      ) : !s ? (
        <ActivityIndicator style={{ marginTop: 24 }} color={t.brand} />
      ) : (
        <>
          <ProviderSettings s={s} admin={admin} onSaved={load} />
          <BudgetSettings s={s} usage={usage} admin={admin} onSaved={load} />
        </>
      )}

      {admin ? (
        <SettingsGroup title="Name and removal">
          <RenameAgent name={name} />
          <GroupBody>
            <Button variant="danger" title={`Remove ${name}`} onPress={remove} />
          </GroupBody>
        </SettingsGroup>
      ) : null}
    </>
  );
}

function ProviderSettings({ s, admin, onSaved }: { s: AgentSettings; admin: boolean; onSaved: () => void }) {
  const t = useTheme();
  const client = useCircle();
  const [provider, setProvider] = useState(s.provider?.provider ?? 'anthropic');
  const choices = s.providers[provider];
  const [model, setModel] = useState(s.provider?.model ?? s.providers.anthropic?.suggested ?? '');
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(s.provider?.baseUrl ?? '');
  const [inUsd, setIn] = useState(s.provider && !choices?.models ? String(s.provider.inUsd) : '');
  const [outUsd, setOut] = useState(s.provider && !choices?.models ? String(s.provider.outUsd) : '');
  const [busy, setBusy] = useState(false);
  const keySaved = s.provider?.keySet && s.provider.provider === provider;
  const pickProvider = (p: string) => {
    setProvider(p);
    setModel(s.providers[p]?.suggested ?? '');
  };
  const save = () => {
    setBusy(true);
    client
      .agentRpc('setSettings', { provider: { provider, model: model.trim(), apiKey: key.trim(), baseUrl: baseUrl.trim(), inUsd: Number(inUsd), outUsd: Number(outUsd) } }, { timeoutMs: 90_000 })
      .then(() => {
        setKey('');
        Alert.alert('Saved', 'The provider answered a test question, so the key and model work.');
        onSaved();
      })
      .catch((e) => Alert.alert('That didn’t work', errorText(e)))
      .finally(() => setBusy(false));
  };
  const input = { color: t.text, fontSize: 16, minHeight: 46, borderWidth: 1, borderColor: t.line, borderRadius: 12, paddingHorizontal: 12, backgroundColor: t.bg } as const;

  if (!admin) {
    return (
      <SettingsGroup title="AI provider">
        <GroupBody>
          <Text style={{ color: t.text, fontSize: 15 }}>{s.provider ? `${s.providers[s.provider.provider]?.name ?? s.provider.provider} · ${s.provider.model}` : 'Not set up yet. An admin adds one.'}</Text>
        </GroupBody>
      </SettingsGroup>
    );
  }
  return (
    <SettingsGroup title="AI provider" footer="You pay the provider directly with your own key. The key is sealed to the agent; the server never stores it readable. Switch provider or model any time: everything it remembers stays.">
      <GroupBody>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {Object.entries(s.providers).map(([id, p]) => {
            const on = id === provider;
            return (
              <Pressable
                key={id}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                onPress={() => pickProvider(id)}
                style={{ minHeight: 40, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: on ? t.brand : t.line, backgroundColor: on ? t.brandSoft : 'transparent' }}
              >
                <Text style={{ color: on ? t.brand : t.text, fontWeight: '600', fontSize: 14 }}>{p.name}</Text>
              </Pressable>
            );
          })}
        </View>

        {choices?.models ? (
          <View style={{ gap: 6 }}>
            {choices.models.map((m) => {
              const on = m.id === model;
              return (
                <Pressable
                  key={m.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  onPress={() => setModel(m.id)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 12, borderRadius: 12, borderWidth: on ? 2 : 1, borderColor: on ? t.brand : t.line }}
                >
                  <Text style={{ flex: 1, color: t.text, fontSize: 15, fontWeight: on ? '700' : '500' }}>
                    {m.name}
                    {m.id === choices.suggested ? '  · suggested' : ''}
                  </Text>
                  <Text style={{ color: t.muted, fontSize: 12 }}>
                    ${m.inUsd} / ${m.outUsd} per M
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <>
            {provider === 'other' ? <TextInput value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" placeholder="Address, e.g. http://192.168.1.20:11434/v1" placeholderTextColor={t.muted} style={input} /> : null}
            <TextInput value={model} onChangeText={setModel} autoCapitalize="none" placeholder="Model name" placeholderTextColor={t.muted} style={input} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput value={inUsd} onChangeText={setIn} keyboardType="decimal-pad" placeholder="$ in / M tokens" placeholderTextColor={t.muted} style={[input, { flex: 1 }]} />
              <TextInput value={outUsd} onChangeText={setOut} keyboardType="decimal-pad" placeholder="$ out / M tokens" placeholderTextColor={t.muted} style={[input, { flex: 1 }]} />
            </View>
            <Text style={{ color: t.muted, fontSize: 12 }}>The model’s price per million tokens, from the provider’s pricing page (0 for a model on your own machine). It’s how spending is counted.</Text>
          </>
        )}

        <TextInput
          value={key}
          onChangeText={setKey}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder={keySaved ? 'API key saved (paste a new one to change it)' : provider === 'other' ? 'API key (if it needs one)' : 'Paste your API key'}
          placeholderTextColor={t.muted}
          style={input}
        />
        <Button variant="primary" title="Save and test" loading={busy} disabled={!model.trim() || (!key.trim() && !keySaved && provider !== 'other')} onPress={save} />
      </GroupBody>
    </SettingsGroup>
  );
}

function BudgetSettings({ s, usage, admin, onSaved }: { s: AgentSettings; usage: Usage | null; admin: boolean; onSaved: () => void }) {
  const t = useTheme();
  const client = useCircle();
  const [budget, setBudget] = useState(s.budgetUsd ? String(s.budgetUsd) : '');
  const save = () =>
    client
      .agentRpc('setSettings', { budgetUsd: Number(budget) || 0 })
      .then(onSaved)
      .catch((e) => Alert.alert('Couldn’t save', errorText(e)));
  const spent = usage?.total ?? 0;
  const cap = s.budgetUsd;
  return (
    <SettingsGroup title="Monthly budget" footer="When it’s used up, the agent stops asking the AI until the 1st. Admins get a heads-up at 80%.">
      <GroupBody>
        <Text style={{ color: t.text, fontSize: 15 }}>
          {usd(spent)} spent this month{cap ? ` of ${usd(cap)}` : ' (no limit set)'}
        </Text>
        {cap ? (
          <View style={{ height: 8, borderRadius: 4, backgroundColor: t.surface2, overflow: 'hidden' }}>
            <View style={{ width: `${Math.min(100, (spent / cap) * 100)}%`, height: 8, backgroundColor: spent >= cap ? t.danger : spent >= 0.8 * cap ? t.accent : t.brand }} />
          </View>
        ) : null}
        {usage?.byMember?.length ? (
          <View style={{ gap: 2 }}>
            {usage.byMember.map((m) => (
              <Text key={m.name} style={{ color: t.muted, fontSize: 13 }}>
                {m.name}: {usd(m.usd)}
              </Text>
            ))}
          </View>
        ) : null}
        {admin ? (
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Text style={{ color: t.text, fontSize: 16 }}>$</Text>
            <TextInput
              value={budget}
              onChangeText={setBudget}
              keyboardType="decimal-pad"
              placeholder="10"
              placeholderTextColor={t.muted}
              accessibilityLabel="Monthly budget in dollars"
              style={{ flex: 1, color: t.text, fontSize: 16, minHeight: 46, borderBottomWidth: 1, borderBottomColor: t.line }}
            />
            <Button small title="Save" disabled={(Number(budget) || 0) === cap} onPress={save} />
          </View>
        ) : null}
      </GroupBody>
    </SettingsGroup>
  );
}

function RenameAgent({ name }: { name: string }) {
  const t = useTheme();
  const client = useCircle();
  const [draft, setDraft] = useState(name);
  return (
    <GroupBody>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          maxLength={24}
          accessibilityLabel="Agent name"
          style={{ flex: 1, color: t.text, fontSize: 16, minHeight: 46, borderBottomWidth: 1, borderBottomColor: t.line }}
        />
        <Button small title="Rename" disabled={!draft.trim() || draft.trim() === name} onPress={() => client.setAgentName(draft.trim()).catch((e) => Alert.alert('Couldn’t rename it', errorText(e)))} />
      </View>
    </GroupBody>
  );
}
