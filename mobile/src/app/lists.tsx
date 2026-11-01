import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import { Button, EmptyState, ErrorText } from '../components/ui';
import { errorText } from '../lib/circle';
import { useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';
import { showSheet } from '../lib/sheet';

// What one costs, from past receipts: the usual price, and the range it has been.
type Price = { est: number; low: number; high: number; n: number };
type Item = { id: string; name: string; by: string; at: number; ticked: boolean; qty: number; usual: number; price?: Price };
type List = {
  id: string;
  name: string;
  createdBy: string;
  items: Item[];
  usual: { name: string; count: number; price?: Price }[];
  // Set when anything on the list has a price: the whole list (each times its quantity), and how many items are priced.
  currency?: string;
  total?: { low: number; high: number; priced: number; count: number };
};

/** "$4.20" (whole units for totals); just the number when the currency isn't known. */
function money(amount: number, currency = '', whole = false) {
  const digits = whole ? 0 : 2;
  try {
    return currency
      ? new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount)
      : amount.toFixed(digits);
  } catch {
    return `${currency} ${amount.toFixed(digits)}`.trim();
  }
}
/** "~ $63 to $78": the low end rounded down and the high end up. */
function rangeText(low: number, high: number, currency = '') {
  const a = Math.floor(low);
  const b = Math.ceil(high);
  return a === b ? `~${money(a, currency, true)}` : `~${money(a, currency, true)} to ${money(b, currency, true)}`;
}

/**
 * The circle's shopping lists, kept by its helper: one per store. Anyone adds,
 * ticks and removes; Done shopping clears what was ticked and counts it as
 * bought, so usual items go first. Everything bought there before (receipts
 * too) is offered to pick from; typing in the add box narrows it. What receipts
 * showed it cost makes an estimated price on each item and an estimated range
 * for the whole cart, shown at the bottom (regular prices, marked as an
 * estimate; tap + on an item for more than one).
 */
// What's bought before, in the row before "More".
const FIRST_USUAL = 12;

/** The lists themselves; the Lists tab shows them under its own title. */
export function ShoppingBody() {
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
  const [allUsual, setAllUsual] = useState(false);

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

  // From the box (cleared after), or one picked from what's bought before (the search stays).
  const add = async (names: string, { fromBox = true } = {}) => {
    if (!list || !names.trim()) return;
    setBusy(true);
    await run('itemAdd', { listId: list.id, names: names.split(',').map((s) => s.trim()).filter(Boolean) });
    setBusy(false);
    if (fromBox) setAdding('');
  };
  const search = adding.trim().toLowerCase();
  const matching = list ? (search ? list.usual.filter((u) => u.name.toLowerCase().includes(search)) : list.usual) : [];
  const shownUsual = search ? matching : matching.slice(0, FIRST_USUAL);
  const moreChip = (label: string) => (
    <Pressable
      key="more"
      accessibilityRole="button"
      onPress={() => setAllUsual((v) => !v)}
      style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: t.brand }}
    >
      <Text style={{ color: t.brand, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
  const usualChip = (u: List['usual'][number]) =>
    list ? (
      <Pressable
        key={u.name}
        accessibilityRole="button"
        accessibilityLabel={u.price ? `Add ${u.name}, about ${money(u.price.est, list.currency)}` : `Add ${u.name}`}
        onPress={() => add(u.name, { fromBox: false })}
        style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 999, backgroundColor: t.surface2 }}
      >
        <Text style={{ color: t.text }}>
          + {u.name}
          {u.price ? <Text style={{ color: t.muted, fontSize: 14 }}> · ~{money(u.price.est, list.currency)}</Text> : null}
        </Text>
      </Pressable>
    ) : null;

  const usualBlock =
    matching.length ? (
      <View style={{ gap: 4 }}>
        <Text style={{ color: t.muted, fontSize: 14, fontWeight: '700' }}>{search ? 'MATCHES' : 'YOU USUALLY GET'}</Text>
        {allUsual && !search ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {matching.map(usualChip)}
            {moreChip('Fewer')}
          </View>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 6, alignItems: 'center' }}>
            {shownUsual.map(usualChip)}
            {!search && matching.length > FIRST_USUAL ? moreChip(`More · ${matching.length - FIRST_USUAL}`) : null}
          </ScrollView>
        )}
      </View>
    ) : null;

  const listMenu = (l: List) =>
    showSheet(l.name, undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete list',
        style: 'destructive',
        onPress: () =>
          showSheet(`Delete ${l.name}?`, 'Its items and what it learned you usually buy go too.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: () => run('listDelete', { listId: l.id }).then(() => setCurrent(null)) },
          ]),
      },
    ]);

  const input = { flex: 1, minHeight: 46, borderRadius: 12, borderWidth: 1, borderColor: t.line, paddingHorizontal: 14, fontSize: 16, color: t.text, backgroundColor: t.surface } as const;
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {!lists ? (
        error ? (
          <View style={{ paddingHorizontal: 16 }}>
            <ErrorText onRetry={() => run('lists')}>{error}</ErrorText>
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
                  style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: on ? t.brand : t.line, backgroundColor: on ? t.brandSoft : t.surface }}
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
              style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderStyle: 'dashed', borderColor: t.line }}
            >
              <Text style={{ color: t.brand, fontWeight: '600' }}>+ New list</Text>
            </Pressable>
          </ScrollView>
          {naming ? (
            <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
              <TextInput accessibilityLabel="Store, like Costco" value={newName} onChangeText={setNewName} placeholder="Store, like Costco" placeholderTextColor={t.muted} autoFocus style={input} />
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
          {error ? (
            <View style={{ paddingHorizontal: 16 }}>
              <ErrorText>{error}</ErrorText>
            </View>
          ) : null}
          {!list ? (
            <EmptyState icon="lists" text={`No lists yet. Make one for each store you go to, or ask ${name} to.`} action="New list" onAction={newList} />
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
              contentContainerStyle={{ padding: 16, paddingTop: 4, gap: 6, paddingBottom: 24 }}
              keyboardShouldPersistTaps="handled"
              ListHeaderComponent={
                <View style={{ gap: 10, marginBottom: 8 }}>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TextInput accessibilityLabel={`Add to ${list.name}, or search what you get`}
                      value={adding}
                      onChangeText={setAdding}
                      placeholder={`Add to ${list.name}, or search what you get`}
                      placeholderTextColor={t.muted}
                      returnKeyType="done"
                      onSubmitEditing={() => add(adding)}
                      style={input}
                    />
                    <Button small variant="primary" title="Add" loading={busy} disabled={!adding.trim()} onPress={() => add(adding)} />
                  </View>
                  {search ? usualBlock : null}
                </View>
              }
              ListFooterComponent={search ? undefined : <View style={{ marginTop: 14 }}>{usualBlock}</View>}
              ListEmptyComponent={<EmptyState icon="lists" text={`Nothing on ${list.name} yet. Add the first thing above.`} />}
              renderItem={({ item }) => (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 12, borderRadius: 12, backgroundColor: t.surface }}>
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: item.ticked }}
                    accessibilityLabel={`${item.qty > 1 ? `${item.qty} ` : ''}${item.name}${item.price ? `, about ${money(item.price.est * item.qty, list.currency)}` : ''}`}
                    onPress={() => run('itemTick', { listId: list.id, itemId: item.id, ticked: !item.ticked })}
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 }}
                  >
                    <Text style={{ fontSize: 22 }}>{item.ticked ? '☑️' : '⬜️'}</Text>
                    <Text style={{ flex: 1, color: item.ticked ? t.muted : t.text, fontSize: 17, textDecorationLine: item.ticked ? 'line-through' : 'none' }}>
                      {item.qty > 1 ? `${item.qty} × ` : ''}
                      {item.name}
                      {item.price ? <Text style={{ color: t.muted, fontSize: 14, textDecorationLine: 'none' }}> · ~{money(item.price.est * item.qty, list.currency)}</Text> : null}
                    </Text>
                    {item.usual >= 2 && !item.ticked ? <Text style={{ color: t.muted, fontSize: 14 }}>usual</Text> : null}
                  </Pressable>
                  {item.qty > 1 ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`One fewer ${item.name}`}
                      hitSlop={4}
                      onPress={() => run('itemQty', { listId: list.id, itemId: item.id, qty: item.qty - 1 })}
                      style={{ minWidth: 36, minHeight: 40, alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Text style={{ color: t.brand, fontSize: 22, fontWeight: '600' }}>−</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`One more ${item.name}`}
                    hitSlop={4}
                    onPress={() => run('itemQty', { listId: list.id, itemId: item.id, qty: item.qty + 1 })}
                    style={{ minWidth: 36, minHeight: 40, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Text style={{ color: t.brand, fontSize: 22, fontWeight: '600' }}>+</Text>
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
          {list && (ticked || list.total) ? (
            <View style={{ gap: 10, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 24, borderTopWidth: 1, borderTopColor: t.line, backgroundColor: t.bg }}>
              {ticked ? <Button variant="primary" title={`Done shopping · clear ${ticked} ticked`} onPress={() => run('doneShopping', { listId: list.id })} /> : null}
              {list.total ? (
                <View
                  accessible
                  accessibilityLabel={`Estimated cart cost: ${rangeText(list.total.low, list.total.high, list.currency)}. ${list.total.priced} of ${list.total.count} items priced.`}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: t.muted, fontSize: 14, fontWeight: '700' }}>ESTIMATED CART</Text>
                    <Text style={{ color: t.text, fontSize: 20, fontWeight: '700' }}>{rangeText(list.total.low, list.total.high, list.currency)}</Text>
                  </View>
                  <Text style={{ color: t.muted, fontSize: 14, textAlign: 'right', flexShrink: 1 }}>
                    {list.total.priced} of {list.total.count} item{list.total.count === 1 ? '' : 's'} priced{'\n'}regular prices, from receipts
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

export default function ShoppingLists() {
  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Shopping lists' }} />
      <ShoppingBody />
    </>
  );
}
