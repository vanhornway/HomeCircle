import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { CircleClient } from '@homecircle/core';
import { Button } from './ui';
import { errorText } from '../lib/circle';
import { OPTION_EMOJI, POLL_TEMPLATES, placeIdeas } from '../lib/polls';
import { useTheme } from '../theme';

type Draft = { label: string; emoji: string };
const blank = (): Draft[] => [
  { label: '', emoji: '' },
  { label: '', emoji: '' },
];

/** When the poll closes: never, in 30 minutes, in an hour, or at 9 tonight. */
function deadlines(now: Date): { label: string; at: number | null }[] {
  const out: { label: string; at: number | null }[] = [
    { label: 'No deadline', at: null },
    { label: '30 min', at: now.getTime() + 30 * 60_000 },
    { label: '1 hour', at: now.getTime() + 60 * 60_000 },
  ];
  const tonight = new Date(now);
  tonight.setHours(21, 0, 0, 0);
  if (tonight.getTime() - now.getTime() > 60 * 60_000) out.push({ label: 'Tonight 9 pm', at: tonight.getTime() });
  return out;
}

/** The "new poll" sheet: question, options with emoji, a few switches and a deadline. */
export function CreatePoll({ client, peer, visible, onClose, onCreated }: { client: CircleClient; peer: string | null; visible: boolean; onClose: () => void; onCreated: () => void }) {
  const t = useTheme();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<Draft[]>(blank);
  const [multi, setMulti] = useState(false);
  const [allowAdd, setAllowAdd] = useState(true);
  const [deadline, setDeadline] = useState(0);
  const [emojiFor, setEmojiFor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => new Date());
  const ends = deadlines(now);
  const ideas = placeIdeas(client).filter((p) => !options.some((o) => o.label.trim().toLowerCase() === p.label.toLowerCase()));
  const filled = options.filter((o) => o.label.trim());

  const reset = () => {
    setQuestion('');
    setOptions(blank());
    setMulti(false);
    setAllowAdd(true);
    setDeadline(0);
    setEmojiFor(null);
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const setOption = (i: number, patch: Partial<Draft>) => setOptions((prev) => prev.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const addIdea = (idea: Draft) =>
    setOptions((prev) => {
      const empty = prev.findIndex((o) => !o.label.trim());
      if (empty >= 0) return prev.map((o, j) => (j === empty ? idea : o));
      return prev.length < 8 ? [...prev, idea] : prev;
    });
  const applyTemplate = (tpl: (typeof POLL_TEMPLATES)[number]) => {
    setQuestion(tpl.question);
    if (tpl.options.length) setOptions(tpl.options.map((o) => ({ ...o })));
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.createPoll(
        { question: question.trim(), options: filled.map((o) => ({ label: o.label.trim(), emoji: o.emoji || undefined })), multi, allowAdd, closesAt: ends[deadline]?.at ?? null },
        { to: peer },
      );
      reset();
      onCreated();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const chip = (selected: boolean) => ({
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: selected ? t.brand : t.line,
    backgroundColor: selected ? t.brandSoft : t.surface,
    justifyContent: 'center' as const,
  });
  const label = { color: t.muted, fontSize: 13, fontWeight: '700' as const, marginTop: 6 };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.line }}>
          <Pressable onPress={close} accessibilityRole="button" hitSlop={8} style={{ minHeight: 48, paddingHorizontal: 10, justifyContent: 'center' }}>
            <Text style={{ color: t.brand, fontSize: 17 }}>Cancel</Text>
          </Pressable>
          <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 18, fontWeight: '700' }}>📊 New poll</Text>
          <View style={{ width: 76 }} />
        </View>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
          <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }} keyboardShouldPersistTaps="handled">
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
              {POLL_TEMPLATES.map((tpl) => (
                <Pressable key={tpl.question} onPress={() => applyTemplate(tpl)} style={chip(question === tpl.question)}>
                  <Text style={{ color: t.text, fontSize: 14 }}>{tpl.question}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Text style={label}>QUESTION</Text>
            <TextInput
              value={question}
              onChangeText={setQuestion}
              placeholder="Ask anything"
              placeholderTextColor={t.muted}
              maxLength={200}
              style={{ backgroundColor: t.surface, borderRadius: 14, borderWidth: 1, borderColor: t.line, paddingHorizontal: 14, minHeight: 52, fontSize: 17, color: t.text }}
            />
            <Text style={label}>OPTIONS</Text>
            {options.map((o, i) => (
              <View key={i}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Pressable
                    accessibilityLabel={o.emoji ? `Emoji ${o.emoji}, tap to change` : 'Pick an emoji'}
                    onPress={() => setEmojiFor(emojiFor === i ? null : i)}
                    style={{ width: 48, height: 48, borderRadius: 14, borderWidth: 1, borderColor: emojiFor === i ? t.brand : t.line, backgroundColor: t.surface, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Text style={{ fontSize: o.emoji ? 22 : 16, color: t.muted }}>{o.emoji || '☺︎'}</Text>
                  </Pressable>
                  <TextInput
                    value={o.label}
                    onChangeText={(v) => setOption(i, { label: v })}
                    placeholder={`Option ${i + 1}`}
                    placeholderTextColor={t.muted}
                    maxLength={60}
                    style={{ flex: 1, backgroundColor: t.surface, borderRadius: 14, borderWidth: 1, borderColor: t.line, paddingHorizontal: 14, minHeight: 48, fontSize: 16, color: t.text }}
                  />
                  {options.length > 2 ? (
                    <Pressable accessibilityLabel={`Remove option ${i + 1}`} onPress={() => setOptions((prev) => prev.filter((_, j) => j !== i))} hitSlop={6} style={{ width: 36, height: 48, alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ color: t.muted, fontSize: 22 }}>×</Text>
                    </Pressable>
                  ) : null}
                </View>
                {emojiFor === i ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 6, backgroundColor: t.surface, borderRadius: 14, padding: 6 }}>
                    {['', ...OPTION_EMOJI].map((e) => (
                      <Pressable
                        key={e || 'none'}
                        accessibilityLabel={e ? `Use ${e}` : 'No emoji'}
                        onPress={() => {
                          setOption(i, { emoji: e });
                          setEmojiFor(null);
                        }}
                        style={({ pressed }) => ({ width: '12.5%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: pressed || o.emoji === e ? t.surface2 : 'transparent' })}
                      >
                        <Text style={{ fontSize: e ? 24 : 14, color: t.muted }}>{e || 'none'}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </View>
            ))}
            {options.length < 8 ? (
              <Pressable onPress={() => setOptions((prev) => [...prev, { label: '', emoji: '' }])} style={{ minHeight: 44, justifyContent: 'center' }}>
                <Text style={{ color: t.brand, fontSize: 16, fontWeight: '600' }}>+ Add option</Text>
              </Pressable>
            ) : null}
            {ideas.length ? (
              <>
                <Text style={label}>IDEAS FROM YOUR PLACES</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {ideas.map((p) => (
                    <Pressable key={p.label} onPress={() => addIdea(p)} style={chip(false)}>
                      <Text style={{ color: t.text, fontSize: 14 }}>
                        {p.emoji} {p.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}
            <Text style={label}>CLOSES</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {ends.map((d, i) => (
                <Pressable key={d.label} onPress={() => setDeadline(i)} accessibilityState={{ selected: deadline === i }} style={chip(deadline === i)}>
                  <Text style={{ color: t.text, fontSize: 14 }}>{d.label}</Text>
                </Pressable>
              ))}
            </View>
            <Toggle title="Pick more than one" value={multi} onChange={setMulti} />
            <Toggle title="Let others add options" value={allowAdd} onChange={setAllowAdd} />
            {error ? <Text style={{ color: t.danger, fontSize: 15 }}>{error}</Text> : null}
            <Button variant="primary" title="Start poll" loading={busy} disabled={!question.trim() || filled.length < 2} onPress={create} style={{ marginTop: 8 }} />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function Toggle({ title, value, onChange }: { title: string; value: boolean; onChange: (v: boolean) => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48 }}>
      <Text style={{ flex: 1, color: t.text, fontSize: 16 }}>{title}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: t.brand, false: t.line }} />
    </View>
  );
}
