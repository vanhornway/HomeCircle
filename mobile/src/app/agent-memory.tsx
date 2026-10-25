import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Pressable, ScrollView, SectionList, Text, TextInput, View } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Tag } from '../components/ui';
import { errorText } from '../lib/circle';
import { useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

type Note = {
  id: string;
  scope: string;
  type: string;
  title: string;
  body: string;
  people: string[];
  start: string | null;
  end: string | null;
  data: { role?: string; kind?: string; count?: number; for?: string[]; fetchedAt?: number; format?: string } | null;
  updatedAt: number;
};
type Detail = { note: Note; history: { at: number; by: string; change: string }[]; linked: Note[] };

// The kinds of note, in the order All shows them.
const TYPES: { id: string | null; label: string; icon: string }[] = [
  { id: null, label: 'All', icon: '🧠' },
  { id: 'person', label: 'People', icon: '🧑' },
  { id: 'place', label: 'Places', icon: '📍' },
  { id: 'event', label: 'Events', icon: '📅' },
  { id: 'schedule', label: 'Schedules', icon: '🗓️' },
  { id: 'decision', label: 'Decisions', icon: '✅' },
  { id: 'fact', label: 'Facts', icon: '💡' },
  { id: 'source', label: 'Calendars & files', icon: '🔗' },
];
const icon = (type: string) => TYPES.find((x) => x.id === type)?.icon ?? '💡';
const day = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const when = (n: Note) => (n.start ? (n.end && n.end !== n.start ? `${day(n.start)} – ${day(n.end)}` : day(n.start)) : null);

/** What the circle's agent remembers: search, browse by kind, open, edit, delete, undo. */
export default function AgentMemory() {
  const t = useTheme();
  const client = useCircle(['circle']);
  const name = client.agent?.name ?? 'The agent';
  const me = client.account?.memberId;
  const [type, setType] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Stable, so a note sheet fetches its note once.
  const closeNote = useCallback(() => setOpen(null), []);
  const closeNew = useCallback(() => setAdding(false), []);

  const load = useCallback(() => {
    setError(null);
    const req = query.trim() ? client.agentRpc<Note[]>('search', { text: query.trim() }) : client.agentRpc<Note[]>('list', { type });
    req
      .then((list) => setNotes(query.trim() && type ? list.filter((n) => n.type === type) : list))
      .catch((e) => setError(errorText(e)));
  }, [client, query, type]);
  useFocusEffect(load);

  // Same as "/Name dream" in a chat: it answers in your chat with it.
  const dream = () =>
    Alert.alert(
      'Dream?',
      `${name} goes through everything the circle shares and sorts it: each note into its kind (people, places, events…), clearer titles, links between them, duplicates merged. It uses the AI budget, and one Undo takes it back.`,
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Dream',
          onPress: () =>
            client
              .askAgent('dream', { peer: client.agent?.id ?? null })
              .then(() => Alert.alert('Dreaming…', `${name} will message you when it’s done.`))
              .catch((e) => setError(errorText(e))),
        },
      ],
    );
  useEffect(() => {
    const id = setTimeout(load, 300);
    return () => clearTimeout(id);
  }, [load]);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen options={{ headerShown: true, title: `What ${name} remembers` }} />
      <View style={{ padding: 16, paddingBottom: 6, gap: 10 }}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search memory"
          placeholderTextColor={t.muted}
          accessibilityLabel="Search memory"
          returnKeyType="search"
          style={{ minHeight: 46, borderRadius: 12, borderWidth: 1, borderColor: t.line, paddingHorizontal: 14, fontSize: 16, color: t.text, backgroundColor: t.surface }}
        />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {TYPES.map((x) => {
            const on = x.id === type;
            return (
              <Pressable
                key={x.label}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                onPress={() => setType(x.id)}
                style={{ minHeight: 38, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: on ? t.brand : t.line, backgroundColor: on ? t.brandSoft : t.surface }}
              >
                <Text style={{ color: on ? t.brand : t.text, fontWeight: '600' }}>
                  {x.icon} {x.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
      {error ? (
        <View style={{ padding: 16, gap: 10 }}>
          <Text style={{ color: t.danger }}>{error}</Text>
          <Button small title="Try again" onPress={load} />
        </View>
      ) : !notes ? (
        <ActivityIndicator style={{ marginTop: 32 }} color={t.brand} />
      ) : (
        <SectionList
          // All, unsearched: one section per kind of note; otherwise one plain list.
          sections={
            type || query.trim()
              ? [{ key: 'all', title: '', data: notes }]
              : TYPES.filter((x) => x.id)
                  .map((x) => ({ key: x.id!, title: `${x.icon} ${x.label} · ${notes.filter((n) => n.type === x.id).length}`, data: notes.filter((n) => n.type === x.id) }))
                  .filter((s) => s.data.length)
          }
          keyExtractor={(n) => n.id}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ padding: 16, paddingTop: 6, gap: 8, paddingBottom: 100 }}
          renderSectionHeader={({ section }) =>
            section.title ? <Text style={{ color: t.muted, fontSize: 13, fontWeight: '700', letterSpacing: 0.5, marginTop: 10, textTransform: 'uppercase' }}>{section.title}</Text> : null
          }
          ListEmptyComponent={
            <Text style={{ color: t.muted, fontSize: 15, lineHeight: 21, textAlign: 'center', marginTop: 24 }}>
              {query ? 'Nothing matches.' : `Nothing yet. Tell ${name} something (“/${name} our dentist is Dr. Lee”), long-press a message and tap Remember, or send it a calendar link or PDF.`}
            </Text>
          }
          renderItem={({ item: n }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => setOpen(n.id)}
              style={({ pressed }) => ({ flexDirection: 'row', gap: 12, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: t.line, backgroundColor: pressed ? t.surface2 : t.surface })}
            >
              <Text style={{ fontSize: 20 }}>{icon(n.type)}</Text>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
                    {n.title}
                  </Text>
                  {n.scope === me ? <Tag label="Private" /> : null}
                  {n.data?.role ? <Tag label={n.data.role} /> : null}
                </View>
                {when(n) ? <Text style={{ color: t.brand, fontSize: 13 }}>{when(n)}</Text> : null}
                <Text style={{ color: t.muted, fontSize: 14 }} numberOfLines={2}>
                  {n.type === 'source'
                    ? `${n.data?.format === 'pdf' ? `PDF · ${n.data?.count ?? 0} dates` : `${n.data?.count ?? 0} events`} · checked every 6 hours`
                    : n.body.replace(/\[\[([^\]]+)\]\]/g, '$1')}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
      <View style={{ position: 'absolute', right: 16, bottom: 24, flexDirection: 'row', gap: 10 }}>
        {client.isAdmin ? <Button title="💤 Dream" onPress={dream} /> : null}
        <Button variant="primary" title="+ Note" onPress={() => setAdding(true)} />
      </View>
      {open ? <NoteSheet id={open} onClose={closeNote} onChanged={load} /> : null}
      {adding ? <NoteSheet id={null} onClose={closeNew} onChanged={load} /> : null}
    </View>
  );
}

/** One note: read it, edit it, see its history and links, delete or undo. With id null, a new note. */
function NoteSheet({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const t = useTheme();
  const client = useCircle();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => Alert.alert('Couldn’t do that', errorText(e));

  useEffect(() => {
    if (!id) return;
    client
      .agentRpc<Detail>('get', { id })
      .then((d) => {
        setDetail(d);
        setTitle(d.note.title);
        setBody(d.note.body);
      })
      .catch((e) => {
        Alert.alert('Couldn’t open it', errorText(e));
        onClose();
      });
  }, [client, id, onClose]);

  const run = (p: Promise<unknown>) => {
    setBusy(true);
    p.then(() => {
      onChanged();
      onClose();
    })
      .catch(fail)
      .finally(() => setBusy(false));
  };
  const save = () =>
    run(id ? client.agentRpc('update', { id, patch: { title: title.trim(), body } }) : client.agentRpc('add', { note: { type: 'fact', title: title.trim(), body }, private: priv }));
  const remove = () =>
    Alert.alert('Delete this note?', 'You can undo it from its history afterwards.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => id && run(client.agentRpc('remove', { id })) },
    ]);

  const input = { color: t.text, fontSize: 16, borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 12, backgroundColor: t.bg } as const;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 8, borderBottomWidth: 1, borderBottomColor: t.line }}>
          <Pressable onPress={onClose} accessibilityRole="button" hitSlop={8} style={{ minHeight: 48, paddingHorizontal: 10, justifyContent: 'center' }}>
            <Text style={{ color: t.brand, fontSize: 17 }}>Close</Text>
          </Pressable>
          <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 17, fontWeight: '700' }}>{id ? (detail ? `${icon(detail.note.type)} Note` : '') : 'New note'}</Text>
          <View style={{ width: 70 }} />
        </View>
        {id && !detail ? (
          <ActivityIndicator style={{ marginTop: 32 }} color={t.brand} />
        ) : (
          <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
            <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
              {detail?.note.type === 'source' ? (
                <Text style={{ color: t.muted, fontSize: 14 }}>
                  A calendar {detail.note.data?.count ?? 0} events long, for {(detail.note.data?.for ?? []).join(', ')}. Its address stays private; ask “/agent list calendars” to see what it reads.
                </Text>
              ) : null}
              <TextInput value={title} onChangeText={setTitle} placeholder="Title" placeholderTextColor={t.muted} maxLength={120} style={[input, { fontWeight: '700' }]} />
              {detail && when(detail.note) ? <Text style={{ color: t.brand, fontSize: 14 }}>{when(detail.note)}</Text> : null}
              <TextInput
                value={body}
                onChangeText={setBody}
                placeholder="What to remember. Link people and places with [[Name]]."
                placeholderTextColor={t.muted}
                multiline
                style={[input, { minHeight: 140, textAlignVertical: 'top' }]}
              />
              {!id ? (
                <Pressable accessibilityRole="switch" accessibilityState={{ checked: priv }} onPress={() => setPriv((v) => !v)} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', minHeight: 44 }}>
                  <Text style={{ fontSize: 18 }}>{priv ? '☑️' : '⬜️'}</Text>
                  <Text style={{ color: t.text, fontSize: 15, flex: 1 }}>Private: only I can recall it</Text>
                </Pressable>
              ) : null}
              <Button variant="primary" title="Save" loading={busy} disabled={!title.trim()} onPress={save} />

              {detail?.linked.length ? (
                <View style={{ gap: 6, marginTop: 8 }}>
                  <Text style={{ color: t.muted, fontSize: 13, fontWeight: '700' }}>LINKED</Text>
                  {detail.linked.map((l) => (
                    <Text key={l.id} style={{ color: t.text, fontSize: 15 }}>
                      {icon(l.type)} {l.title}
                    </Text>
                  ))}
                </View>
              ) : null}
              {detail?.history.length ? (
                <View style={{ gap: 4, marginTop: 8 }}>
                  <Text style={{ color: t.muted, fontSize: 13, fontWeight: '700' }}>HISTORY</Text>
                  {detail.history.map((h, i) => (
                    <Text key={i} style={{ color: t.muted, fontSize: 14 }}>
                      {h.change[0].toUpperCase()}
                      {h.change.slice(1)} by {h.by}, {new Date(h.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </Text>
                  ))}
                  {detail.history.length > 1 ? <Button small title="Undo the last change" onPress={() => run(client.agentRpc('undo', { id }))} /> : null}
                </View>
              ) : null}
              {id ? <Button variant="danger" title="Delete" onPress={remove} style={{ marginTop: 8 }} /> : null}
            </ScrollView>
          </KeyboardAvoidingView>
        )}
      </SafeAreaView>
    </Modal>
  );
}
