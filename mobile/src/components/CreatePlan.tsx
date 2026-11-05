import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { CircleClient } from '@homecircle/core';
import { Button, ErrorText } from './ui';
import { Choice } from './PeopleChips';
import { DatePicker } from './DatePicker';
import { errorText } from '../lib/circle';
import { useTheme } from '../theme';

// Half-hour steps through the day people actually plan things in.
const TIMES = Array.from({ length: 34 }, (_, i) => 6 * 60 + i * 30);
const LENGTHS = [
  { id: '60', label: '1 hour' },
  { id: '120', label: '2 hours' },
  { id: '240', label: 'Half a day' },
];
const clock = (mins: number) => new Date(2000, 0, 1, 0, mins).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** The "new plan" sheet: what, which day, what time, where. */
export function CreatePlan({ client, visible, onClose, onCreated }: { client: CircleClient; visible: boolean; onClose: () => void; onCreated: () => void }) {
  const t = useTheme();
  const [title, setTitle] = useState('');
  const [day, setDay] = useState<string | null>(null);
  const [allDay, setAllDay] = useState(false);
  const [time, setTime] = useState(18 * 60);
  const [length, setLength] = useState('60');
  const [where, setWhere] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!day) return;
    setBusy(true);
    setError(null);
    const [y, m, d] = day.split('-').map(Number);
    const start = allDay ? new Date(y, m - 1, d).getTime() : new Date(y, m - 1, d, 0, time).getTime();
    const end = allDay ? new Date(y, m - 1, d + 1).getTime() : start + Number(length) * 60_000;
    try {
      await client.createPlan({ title: title.trim(), start, end, allDay, where: where.trim() });
      setTitle('');
      setDay(null);
      setWhere('');
      onCreated();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const input = { color: t.text, fontSize: 16, borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 12, backgroundColor: t.bg } as const;
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 8, borderBottomWidth: 1, borderBottomColor: t.line }}>
          <Pressable onPress={onClose} accessibilityRole="button" hitSlop={8} style={{ minHeight: 48, paddingHorizontal: 10, justifyContent: 'center' }}>
            <Text style={{ color: t.brand, fontSize: 17 }}>Close</Text>
          </Pressable>
          <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 17, fontWeight: '700' }}>New plan</Text>
          <View style={{ width: 70 }} />
        </View>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
          <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
            <TextInput accessibilityLabel="What’s the plan, like Dinner at Nani’s" value={title} onChangeText={setTitle} placeholder="What’s the plan, like Dinner at Nani’s" placeholderTextColor={t.muted} maxLength={80} style={[input, { fontWeight: '700' }]} />
            <DatePicker value={day} onChange={setDay} label="Which day" />
            <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48 }}>
              <Text style={{ flex: 1, color: t.text, fontSize: 16 }}>All day</Text>
              <Switch accessibilityLabel="All day" value={allDay} onValueChange={setAllDay} />
            </View>
            {allDay ? null : (
              <>
                <Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>What time</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8 }}>
                  {TIMES.map((m) => {
                    const on = m === time;
                    return (
                      <Pressable
                        key={m}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: on }}
                        onPress={() => setTime(m)}
                        style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: on ? t.brand : t.line, backgroundColor: on ? t.brandSoft : t.surface }}
                      >
                        <Text style={{ color: on ? t.brand : t.text, fontWeight: '600' }}>{clock(m)}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
                <Choice options={LENGTHS} value={length} onPick={setLength} />
              </>
            )}
            <TextInput accessibilityLabel="Where (optional)" value={where} onChangeText={setWhere} placeholder="Where (optional)" placeholderTextColor={t.muted} maxLength={120} style={input} />
            <Button variant="primary" title="Share with the circle" loading={busy} disabled={!title.trim() || !day} onPress={create} />
            <ErrorText>{error}</ErrorText>
            <Text style={{ color: t.muted, fontSize: 14 }}>Everyone answers in the chat. It goes into someone’s calendar only if they tap Add to my calendar.</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
