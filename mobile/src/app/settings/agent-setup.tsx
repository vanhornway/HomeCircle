import { useCallback, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Button } from '../../components/ui';
import { GroupBody, SettingsGroup, SettingsPage } from '../../components/SettingsKit';
import { errorText } from '../../lib/circle';
import { downloadMemory } from '../../lib/memoryDownload';
import { useCircle } from '../../lib/useCircle';
import { useTheme } from '../../theme';
import { showSheet } from '../../lib/sheet';

type ModelChoice = { id: string; name: string; inUsd: number; outUsd: number };
type AgentSettings = {
  name: string;
  provider: { provider: string; model: string; baseUrl: string | null; inUsd: number; outUsd: number; keySet: boolean } | null;
  budgetUsd: number;
  providers: Record<string, { name: string; models: ModelChoice[] | null; suggested: string | null }>;
};
type Usage = { total: number; budgetUsd: number; byMember: { name: string; usd: number }[] | null };

const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`;

/** Admins: the helper's name, its AI provider and budget, and removing it. */
export default function AgentSetupPage() {
  const t = useTheme();
  const client = useCircle(['circle', 'members']);
  const agent = client.agent;
  if (!agent || !client.isAdmin) {
    return (
      <SettingsPage title="Set up">
        <Text style={{ color: t.muted, fontSize: 15, marginTop: 22, marginHorizontal: 4 }}>{agent ? `Only the circle’s admins can set up ${agent.name}.` : 'This circle has no helper yet.'}</Text>
      </SettingsPage>
    );
  }
  return (
    <SettingsPage title={`Set up ${agent.name}`}>
      <Setup name={agent.name} />
    </SettingsPage>
  );
}

function Setup({ name }: { name: string }) {
  const t = useTheme();
  const client = useCircle();
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
    showSheet(`Remove ${name}?`, 'Its memory is deleted for good. You can download a copy first.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Download first',
        onPress: () => {
          downloadMemory(client).catch((e) => showSheet('Couldn’t download it', errorText(e)));
        },
      },
      { text: 'Remove', style: 'destructive', onPress: () => client.removeAgent().catch((e) => showSheet('Couldn’t remove it', errorText(e))) },
    ]);

  return (
    <>
      <SettingsGroup title="Name" footer={`People ask it by name: “${name}, when is the dentist?”`}>
        <RenameAgent name={name} />
      </SettingsGroup>

      {error ? (
        <SettingsGroup title="AI provider">
          <GroupBody>
            <Text style={{ color: t.danger, fontSize: 14 }}>{error}</Text>
            <Button small title="Try again" onPress={load} />
          </GroupBody>
        </SettingsGroup>
      ) : !s ? (
        <Loading />
      ) : (
        <>
          <ProviderSettings s={s} onSaved={load} />
          <BudgetSettings s={s} usage={usage} onSaved={load} />
        </>
      )}

      <SettingsGroup title="Remove" footer="Its memory is deleted for good. Download a copy first from the helper’s page.">
        <GroupBody>
          <Button variant="danger" title={`Remove ${name}`} onPress={remove} />
        </GroupBody>
      </SettingsGroup>
    </>
  );
}

/** While its settings load: the same groups, greyed, so nothing moves when they arrive. */
function Loading() {
  const t = useTheme();
  const bar = (width: `${number}%`, height = 16) => <View style={{ width, height, borderRadius: 8, backgroundColor: t.surface2 }} />;
  return (
    <View accessible accessibilityLabel="Loading">
      <SettingsGroup title="AI provider">
        <GroupBody>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {bar('28%', 40)}
            {bar('22%', 40)}
            {bar('26%', 40)}
          </View>
          {bar('100%', 48)}
          {bar('100%', 48)}
          {bar('100%', 46)}
          {bar('100%', 48)}
        </GroupBody>
      </SettingsGroup>
      <SettingsGroup title="Monthly budget">
        <GroupBody>
          {bar('55%')}
          {bar('100%', 46)}
        </GroupBody>
      </SettingsGroup>
    </View>
  );
}

function ProviderSettings({ s, onSaved }: { s: AgentSettings; onSaved: () => void }) {
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
        showSheet('Saved', 'The provider answered a test question, so the key and model work.');
        onSaved();
      })
      .catch((e) => showSheet('That didn’t work', errorText(e)))
      .finally(() => setBusy(false));
  };
  const input = { color: t.text, fontSize: 16, minHeight: 46, borderWidth: 1, borderColor: t.line, borderRadius: 12, paddingHorizontal: 12, backgroundColor: t.bg } as const;

  return (
    <SettingsGroup title="AI provider" footer="You pay the provider directly with your own key. The key is sealed to the helper; the server never stores it readable. Switch provider or model any time: everything it remembers stays.">
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
                style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: on ? t.brand : t.line, backgroundColor: on ? t.brandSoft : 'transparent' }}
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
                  <Text style={{ color: t.muted, fontSize: 14 }}>
                    ${m.inUsd} / ${m.outUsd} per M
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <>
            {provider === 'other' ? <TextInput accessibilityLabel="Address, e.g. http://192.168.1.20:11434/v1" value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" placeholder="Address, e.g. http://192.168.1.20:11434/v1" placeholderTextColor={t.muted} style={input} /> : null}
            <TextInput accessibilityLabel="Model name" value={model} onChangeText={setModel} autoCapitalize="none" placeholder="Model name" placeholderTextColor={t.muted} style={input} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput accessibilityLabel="$ in / M tokens" value={inUsd} onChangeText={setIn} keyboardType="decimal-pad" placeholder="$ in / M tokens" placeholderTextColor={t.muted} style={[input, { flex: 1 }]} />
              <TextInput accessibilityLabel="$ out / M tokens" value={outUsd} onChangeText={setOut} keyboardType="decimal-pad" placeholder="$ out / M tokens" placeholderTextColor={t.muted} style={[input, { flex: 1 }]} />
            </View>
            <Text style={{ color: t.muted, fontSize: 14 }}>The model’s price per million tokens, from the provider’s pricing page (0 for a model on your own machine). It’s how spending is counted.</Text>
          </>
        )}

        <TextInput accessibilityLabel={keySaved ? 'API key saved (paste a new one to change it)' : provider === 'other' ? 'API key (if it needs one)' : 'Paste your API key'}
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

function BudgetSettings({ s, usage, onSaved }: { s: AgentSettings; usage: Usage | null; onSaved: () => void }) {
  const t = useTheme();
  const client = useCircle();
  const [budget, setBudget] = useState(s.budgetUsd ? String(s.budgetUsd) : '');
  const save = () =>
    client
      .agentRpc('setSettings', { budgetUsd: Number(budget) || 0 })
      .then(onSaved)
      .catch((e) => showSheet('Couldn’t save', errorText(e)));
  const spent = usage?.total ?? 0;
  const cap = s.budgetUsd;
  return (
    <SettingsGroup title="Monthly budget" footer="When it’s used up, the helper stops asking the AI until the 1st. Admins get a heads-up at 80%.">
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
              <Text key={m.name} style={{ color: t.muted, fontSize: 14 }}>
                {m.name}: {usd(m.usd)}
              </Text>
            ))}
          </View>
        ) : null}
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
          accessibilityLabel="Helper’s name"
          style={{ flex: 1, color: t.text, fontSize: 16, minHeight: 46, borderBottomWidth: 1, borderBottomColor: t.line }}
        />
        <Button small title="Rename" disabled={!draft.trim() || draft.trim() === name} onPress={() => client.setAgentName(draft.trim()).catch((e) => showSheet('Couldn’t rename it', errorText(e)))} />
      </View>
    </GroupBody>
  );
}
