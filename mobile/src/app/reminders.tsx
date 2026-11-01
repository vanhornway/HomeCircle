import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ADD_BUTTON_SPACE, AddButton, Button, EmptyState, ErrorText, Tag } from '../components/ui';
import { HowThisWorks } from '../components/HowThisWorks';
import { errorText } from '../lib/circle';
import { daysUntil, parseDueDate, prettyDate } from '../lib/dueDate';
import { useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';
import { showSheet } from '../lib/sheet';

type Reminder = { id: string; title: string; due: string; repeat: 'none' | 'yearly' | 'months'; months?: number; note: string; createdBy: string; createdByName: string; done: boolean };

const whenText = (r: Reminder) => {
  if (r.done) return 'Done';
  const d = daysUntil(r.due);
  return d < 0 ? `${-d} day${d === -1 ? '' : 's'} late` : d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : `In ${d} days`;
};

/**
 * Long-term reminders (car registration, passports, insurance), kept by the
 * circle's helper: every admin, and whoever added one, hears 30, 7 and 1
 * days before, on the day, and every few days after until it's done.
 */
export function RemindersBody() {
  const t = useTheme();
  const client = useCircle(['circle']);
  const [list, setList] = useState<Reminder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Reminder | 'new' | null>(null);

  const run = useCallback(
    (op: string, args: Record<string, unknown> = {}) => {
      setError(null);
      return client
        .agentRpc<Reminder[]>(op, args)
        .then((next) => {
          setList(next);
          return true;
        })
        .catch((e) => {
          setError(errorText(e));
          return false;
        });
    },
    [client],
  );
  useFocusEffect(
    useCallback(() => {
      run('reminders');
    }, [run]),
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {error ? (
        <View style={{ paddingHorizontal: 16 }}>
          <ErrorText onRetry={() => run('reminders')}>{error}</ErrorText>
        </View>
      ) : null}
      {!list ? (
        <ActivityIndicator style={{ marginTop: 32 }} color={t.brand} />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: 16, gap: 8, paddingBottom: ADD_BUTTON_SPACE }}
          ListHeaderComponent={
            <View style={{ marginBottom: 6 }}>
              <Text style={{ color: t.muted, fontSize: 15, lineHeight: 21 }}>Things that come once a year, like a car registration.</Text>
              <HowThisWorks title="How reminders work">
                Things that come once a year or so, like a car registration. Every admin, and whoever added it, is reminded 30, 7 and 1 days before, on the day, and every few days after until someone marks it done.
              </HowThisWorks>
            </View>
          }
          ListEmptyComponent={<EmptyState icon="bell" text="No reminders yet." action="Add a reminder" onAction={() => setEditing('new')} />}
          renderItem={({ item: r }) => {
            const late = !r.done && daysUntil(r.due) < 0;
            return (
              <Pressable
                accessibilityRole="button"
                onPress={() => setEditing(r)}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: late ? t.danger : t.line, backgroundColor: pressed ? t.surface2 : t.surface, opacity: r.done ? 0.6 : 1 })}
              >
                <Text style={{ fontSize: 22 }}>{r.done ? '✅' : '⏰'}</Text>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{r.title}</Text>
                    {r.repeat !== 'none' ? <Tag label={repeatLabel(r)} /> : null}
                  </View>
                  <Text style={{ color: late ? t.danger : t.brand, fontSize: 14 }}>
                    {whenText(r)} · {prettyDate(r.due)}
                  </Text>
                  <Text style={{ color: t.muted, fontSize: 14 }}>Added by {r.createdByName}</Text>
                </View>
                {!r.done ? <Button small title="Done" onPress={() => run('reminderDone', { id: r.id })} /> : null}
              </Pressable>
            );
          }}
        />
      )}
      <AddButton label="Reminder" hint="Add a reminder" onPress={() => setEditing('new')} />
      {editing ? <ReminderSheet reminder={editing === 'new' ? null : editing} onClose={() => setEditing(null)} run={run} /> : null}
    </View>
  );
}

const repeatLabel = (r: Reminder) => (r.repeat === 'yearly' ? 'every year' : r.months === 1 ? 'every month' : `every ${r.months} months`);

function ReminderSheet({ reminder, onClose, run }: { reminder: Reminder | null; onClose: () => void; run: (op: string, args?: Record<string, unknown>) => Promise<boolean> }) {
  const t = useTheme();
  const [title, setTitle] = useState(reminder?.title ?? '');
  const [date, setDate] = useState(reminder?.due ?? '');
  const [repeat, setRepeat] = useState<Reminder['repeat']>(reminder ? reminder.repeat : 'yearly');
  const [months, setMonths] = useState(reminder?.months ?? 6);
  const [note, setNote] = useState(reminder?.note ?? '');
  const [busy, setBusy] = useState(false);
  const due = parseDueDate(date);
  const save = async () => {
    if (!due) return;
    setBusy(true);
    const fields = { title: title.trim(), due, repeat, ...(repeat === 'months' ? { months } : {}), note: note.trim() };
    const ok = await run(reminder ? 'reminderUpdate' : 'reminderAdd', reminder ? { id: reminder.id, ...fields } : fields);
    setBusy(false);
    if (ok) onClose();
  };
  const remove = () =>
    reminder &&
    showSheet(`Delete “${reminder.title}”?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => run('reminderRemove', { id: reminder.id }).then((ok) => ok && onClose()) },
    ]);
  const input = { color: t.text, fontSize: 16, borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 12, backgroundColor: t.bg } as const;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 8, borderBottomWidth: 1, borderBottomColor: t.line }}>
          <Pressable onPress={onClose} accessibilityRole="button" hitSlop={8} style={{ minHeight: 48, paddingHorizontal: 10, justifyContent: 'center' }}>
            <Text style={{ color: t.brand, fontSize: 17 }}>Close</Text>
          </Pressable>
          <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 17, fontWeight: '700' }}>{reminder ? 'Reminder' : 'New reminder'}</Text>
          <View style={{ width: 70 }} />
        </View>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
          <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
            {reminder ? (
              <Text style={{ color: !reminder.done && daysUntil(reminder.due) < 0 ? t.danger : t.muted, fontSize: 14 }}>
                {whenText(reminder)} · Added by {reminder.createdByName}
              </Text>
            ) : null}
            <TextInput value={title} onChangeText={setTitle} placeholder="What, like Car registration" placeholderTextColor={t.muted} maxLength={80} style={[input, { fontWeight: '700' }]} />
            <TextInput value={date} onChangeText={setDate} placeholder="When it’s due: Nov 30, or 11/30/2027" placeholderTextColor={t.muted} autoCapitalize="none" style={input} />
            <Text style={{ color: date && !due ? t.danger : t.brand, fontSize: 14 }}>{date ? (due ? prettyDate(due) : 'That isn’t a date I know. Try “Nov 30”.') : ' '}</Text>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>Repeat</Text>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {(
                [
                  ['none', 'Never'],
                  ['yearly', 'Every year'],
                  ['months', 'Every few months'],
                ] as const
              ).map(([id, label]) => {
                const on = repeat === id;
                return (
                  <Pressable
                    key={id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    onPress={() => setRepeat(id)}
                    style={{ minHeight: 44, paddingHorizontal: 16, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: on ? t.brand : t.line, backgroundColor: on ? t.brandSoft : 'transparent' }}
                  >
                    <Text style={{ color: on ? t.brand : t.text, fontWeight: '600', fontSize: 16 }}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
            {repeat === 'months' ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 }}>
                <Text style={{ flex: 1, color: t.text, fontSize: 16 }}>{months === 1 ? 'Every month' : `Every ${months} months`}</Text>
                <Button small title="−" accessibilityLabel="One month fewer" disabled={months <= 1} onPress={() => setMonths((m) => Math.max(1, m - 1))} />
                <Button small title="+" accessibilityLabel="One month more" disabled={months >= 60} onPress={() => setMonths((m) => Math.min(60, m + 1))} />
              </View>
            ) : null}
            <TextInput value={note} onChangeText={setNote} placeholder="A note, like where to renew (optional)" placeholderTextColor={t.muted} multiline style={[input, { minHeight: 80, textAlignVertical: 'top' }]} />
            <Button variant="primary" title="Save" loading={busy} disabled={!title.trim() || !due} onPress={save} />
            {reminder ? <Button variant="danger" title="Delete" onPress={remove} /> : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

export default function Reminders() {
  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Reminders' }} />
      <RemindersBody />
    </>
  );
}
