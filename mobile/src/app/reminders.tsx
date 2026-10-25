import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Tag } from '../components/ui';
import { errorText } from '../lib/circle';
import { daysUntil, parseDueDate, prettyDate } from '../lib/dueDate';
import { useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

type Reminder = { id: string; title: string; due: string; repeat: 'none' | 'yearly'; note: string; createdBy: string; createdByName: string; done: boolean };

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
export default function Reminders() {
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
      <Stack.Screen options={{ headerShown: true, title: 'Reminders' }} />
      {error ? <Text style={{ color: t.danger, padding: 16, paddingBottom: 0 }}>{error}</Text> : null}
      {!list ? (
        <ActivityIndicator style={{ marginTop: 32 }} color={t.brand} />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: 16, gap: 8, paddingBottom: 110 }}
          ListHeaderComponent={
            <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20, marginBottom: 6 }}>
              Things that come once a year or so, like a car registration. Every admin, and whoever added it, is reminded 30, 7 and 1 days before, on the day, and every few days after until someone marks it done.
            </Text>
          }
          ListEmptyComponent={<Text style={{ color: t.muted, textAlign: 'center', marginTop: 24 }}>No reminders yet.</Text>}
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
                    {r.repeat === 'yearly' ? <Tag label="every year" /> : null}
                  </View>
                  <Text style={{ color: late ? t.danger : t.brand, fontSize: 14 }}>
                    {whenText(r)} · {prettyDate(r.due)}
                  </Text>
                  <Text style={{ color: t.muted, fontSize: 12 }}>Added by {r.createdByName}</Text>
                </View>
                {!r.done ? <Button small title="Done" onPress={() => run('reminderDone', { id: r.id })} /> : null}
              </Pressable>
            );
          }}
        />
      )}
      <View style={{ position: 'absolute', right: 16, bottom: 28 }}>
        <Button variant="primary" title="+ Reminder" onPress={() => setEditing('new')} />
      </View>
      {editing ? <ReminderSheet reminder={editing === 'new' ? null : editing} onClose={() => setEditing(null)} run={run} /> : null}
    </View>
  );
}

function ReminderSheet({ reminder, onClose, run }: { reminder: Reminder | null; onClose: () => void; run: (op: string, args?: Record<string, unknown>) => Promise<boolean> }) {
  const t = useTheme();
  const [title, setTitle] = useState(reminder?.title ?? '');
  const [date, setDate] = useState(reminder?.due ?? '');
  const [yearly, setYearly] = useState(reminder ? reminder.repeat === 'yearly' : true);
  const [note, setNote] = useState(reminder?.note ?? '');
  const [busy, setBusy] = useState(false);
  const due = parseDueDate(date);
  const save = async () => {
    if (!due) return;
    setBusy(true);
    const fields = { title: title.trim(), due, repeat: yearly ? 'yearly' : 'none', note: note.trim() };
    const ok = await run(reminder ? 'reminderUpdate' : 'reminderAdd', reminder ? { id: reminder.id, ...fields } : fields);
    setBusy(false);
    if (ok) onClose();
  };
  const remove = () =>
    reminder &&
    Alert.alert(`Delete “${reminder.title}”?`, undefined, [
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
            <TextInput value={title} onChangeText={setTitle} placeholder="What, like Car registration" placeholderTextColor={t.muted} maxLength={80} style={[input, { fontWeight: '700' }]} />
            <TextInput value={date} onChangeText={setDate} placeholder="When it’s due: Nov 30, or 11/30/2027" placeholderTextColor={t.muted} autoCapitalize="none" style={input} />
            <Text style={{ color: date && !due ? t.danger : t.brand, fontSize: 14 }}>{date ? (due ? prettyDate(due) : 'That isn’t a date I know. Try “Nov 30”.') : ' '}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 }}>
              <Text style={{ flex: 1, color: t.text, fontSize: 16 }}>Every year</Text>
              <Switch accessibilityLabel="Every year" value={yearly} onValueChange={setYearly} trackColor={{ true: t.brand }} />
            </View>
            <TextInput value={note} onChangeText={setNote} placeholder="A note, like where to renew (optional)" placeholderTextColor={t.muted} multiline style={[input, { minHeight: 80, textAlignVertical: 'top' }]} />
            <Button variant="primary" title="Save" loading={busy} disabled={!title.trim() || !due} onPress={save} />
            {reminder ? <Button variant="danger" title="Delete" onPress={remove} /> : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
