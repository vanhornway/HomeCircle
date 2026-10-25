import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import { Button } from '../components/ui';
import { errorText } from '../lib/circle';
import { useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

type Item = { id: string; name: string; by: string; at: number; ticked: boolean; usual: number };
type List = { id: string; name: string; createdBy: string; items: Item[]; usual: { name: string; count: number }[] };

/**
 * The circle's shopping lists, kept by its helper: one per store. Anyone adds,
 * ticks and removes; Done shopping clears what was ticked and counts it as
 * bought, so usual items go first and are suggested.
 */
export default function ShoppingLists() {
  const t = useTheme();
  const client = useCircle(['circle']);
  const name = client.agent?.name ?? 'The helper';
  const [lists, setLists] = useState<List[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Naming a new list (a field under the list chips).
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState('');

  const run = useCallback(
    (op: string, args: Record<string, unknown> = {}) => {
      setError(null);
      return client
        .agentRpc<List[]>(op, args)
        .then((next) => {
          setLists(next);
          return next;
        })
        .catch((e) => {
          setError(errorText(e));
          return null;
        });
    },
    [client],
  );
  useFocusEffect(
    useCallback(() => {
      run('lists');
    }, [run]),
  );

  const list = lists?.find((l) => l.id === current) ?? lists?.[0] ?? null;
  const ticked = list?.items.filter((i) => i.ticked).length ?? 0;

  const newList = () => setNaming(true);

  const add = async (names: string) => {
    if (!list || !names.trim()) return;
    setBusy(true);
    await run('itemAdd', { listId: list.id, names: names.split(',').map((s) => s.trim()).filter(Boolean) });
    setBusy(false);
    setAdding('');
  };

  const listMenu = (l: List) =>
    Alert.alert(l.name, undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete list',
        style: 'destructive',
        onPress: () =>
          Alert.alert(`Delete ${l.name}?`, 'Its items and what it learned you usually buy go too.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: () => run('listDelete', { listId: l.id }).then(() => setCurrent(null)) },
          ]),
      },
    ]);

  const input = { flex: 1, minHeight: 46, borderRadius: 12, borderWidth: 1, borderColor: t.line, paddingHorizontal: 14, fontSize: 16, color: t.text, backgroundColor: t.surface } as const;
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen options={{ headerShown: true, title: 'Shopping lists' }} />
      {!lists ? (
        error ? (
          <View style={{ padding: 16, gap: 10 }}>
            <Text style={{ color: t.danger }}>{error}</Text>
            <Button small title="Try again" onPress={() => run('lists')} />
          </View>
        ) : (
          <ActivityIndicator style={{ marginTop: 32 }} color={t.brand} />
        )
      ) : (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, padding: 16, paddingBottom: 8 }}>
            {lists.map((l) => {
              const on = l.id === list?.id;
              const open = l.items.filter((i) => !i.ticked).length;
              return (
                <Pressable
                  key={l.id}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on }}
                  accessibilityHint="Long-press to delete"
                  onPress={() => setCurrent(l.id)}
                  onLongPress={() => listMenu(l)}
                  style={{ minHeight: 40, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: on ? t.brand : t.line, backgroundColor: on ? t.brandSoft : t.surface }}
                >
                  <Text style={{ color: on ? t.brand : t.text, fontWeight: '600' }}>
                    {l.name}
                    {open ? ` · ${open}` : ''}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              accessibilityRole="button"
              onPress={newList}
              style={{ minHeight: 40, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderStyle: 'dashed', borderColor: t.line }}
            >
              <Text style={{ color: t.brand, fontWeight: '600' }}>+ New list</Text>
            </Pressable>
          </ScrollView>
          {naming ? (
            <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
              <TextInput value={newName} onChangeText={setNewName} placeholder="Store, like Costco" placeholderTextColor={t.muted} autoFocus style={input} />
              <Button
                small
                variant="primary"
                title="Make it"
                disabled={!newName.trim()}
                onPress={() =>
                  run('listCreate', { name: newName.trim() }).then((l) => {
                    if (l) setCurrent(l.find((x) => x.name.toLowerCase() === newName.trim().toLowerCase())?.id ?? null);
                    setNaming(false);
                    setNewName('');
                  })
                }
              />
            </View>
          ) : null}
          {error ? <Text style={{ color: t.danger, paddingHorizontal: 16 }}>{error}</Text> : null}
          {!list ? (
            <Text style={{ color: t.muted, fontSize: 15, lineHeight: 21, textAlign: 'center', margin: 24 }}>
              No lists yet. Make one for each store you go to. You can also tell {name}: “/{name} add milk to the Costco list”, or send it a receipt.
            </Text>
          ) : (
            <FlatList
              data={list.items}
              keyExtractor={(i) => i.id}
              refreshControl={
                <RefreshControl
                  refreshing={false}
                  onRefresh={() => {
                    run('lists');
                  }}
                />
              }
              contentContainerStyle={{ padding: 16, paddingTop: 4, gap: 6, paddingBottom: 120 }}
              keyboardShouldPersistTaps="handled"
              ListHeaderComponent={
                <View style={{ gap: 10, marginBottom: 8 }}>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TextInput
                      value={adding}
                      onChangeText={setAdding}
                      placeholder={`Add to ${list.name} (milk, eggs…)`}
                      placeholderTextColor={t.muted}
                      returnKeyType="done"
                      onSubmitEditing={() => add(adding)}
                      style={input}
                    />
                    <Button small variant="primary" title="Add" loading={busy} disabled={!adding.trim()} onPress={() => add(adding)} />
                  </View>
                  {list.usual.length ? (
                    <View style={{ gap: 6 }}>
                      <Text style={{ color: t.muted, fontSize: 13, fontWeight: '700' }}>YOU USUALLY GET</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                        {list.usual.map((u) => (
                          <Pressable
                            key={u.name}
                            accessibilityRole="button"
                            accessibilityLabel={`Add ${u.name}`}
                            onPress={() => add(u.name)}
                            style={{ minHeight: 34, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 999, backgroundColor: t.surface2 }}
                          >
                            <Text style={{ color: t.text }}>+ {u.name}</Text>
                          </Pressable>
                        ))}
                      </View>
                    </View>
                  ) : null}
                </View>
              }
              ListEmptyComponent={<Text style={{ color: t.muted, textAlign: 'center', marginTop: 16 }}>Nothing on {list.name} yet.</Text>}
              renderItem={({ item }) => (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 12, borderRadius: 12, backgroundColor: t.surface }}>
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: item.ticked }}
                    accessibilityLabel={item.name}
                    onPress={() => run('itemTick', { listId: list.id, itemId: item.id, ticked: !item.ticked })}
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 }}
                  >
                    <Text style={{ fontSize: 22 }}>{item.ticked ? '☑️' : '⬜️'}</Text>
                    <Text style={{ flex: 1, color: item.ticked ? t.muted : t.text, fontSize: 17, textDecorationLine: item.ticked ? 'line-through' : 'none' }}>{item.name}</Text>
                    {item.usual >= 2 && !item.ticked ? <Text style={{ color: t.muted, fontSize: 12 }}>usual</Text> : null}
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${item.name}`}
                    hitSlop={8}
                    onPress={() => run('itemRemove', { listId: list.id, itemId: item.id })}
                    style={{ minWidth: 40, minHeight: 40, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Text style={{ color: t.muted, fontSize: 18 }}>✕</Text>
                  </Pressable>
                </View>
              )}
            />
          )}
          {list && ticked ? (
            <View style={{ position: 'absolute', left: 16, right: 16, bottom: 28 }}>
              <Button variant="primary" title={`Done shopping · clear ${ticked} ticked`} onPress={() => run('doneShopping', { listId: list.id })} />
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}
