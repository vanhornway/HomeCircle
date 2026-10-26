import { useState } from 'react';
import { FlatList, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { CircleClient, Message } from '@homecircle/core';
import { Avatar, Button } from '../../components/ui';
import { ServerBanner } from '../../components/ServerBanner';
import { getClient } from '../../lib/circle';
import { initials, useAllCircles } from '../../lib/useCircle';
import { unreadIn } from '../../lib/unread';
import { useSettings } from '../../lib/storage';
import { previewText } from '../../lib/polls';
import { useTheme } from '../../theme';

type Row = {
  key: string;
  client: CircleClient;
  peer: string | null;
  title: string;
  subtitle: string;
  color: string | null;
  last: Message | undefined;
  unread: number;
};

function when(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (now.getTime() - ts < 6 * 86400_000) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function preview(client: CircleClient, m: Message | undefined, group: boolean) {
  if (!m) return group ? 'No messages yet' : 'Say hello';
  const mine = m.from === client.account?.memberId;
  const name = mine ? 'You' : client.members.get(m.from)?.name || 'Someone';
  if (m.kind === 'event') return `${name} ${m.body?.action === 'left' ? 'left' : 'arrived at'} ${m.body?.placeName || 'a place'}`;
  if (m.kind !== 'chat') return '🔒 Encrypted message';
  const text = previewText(m).replace(/\s+/g, ' ');
  return group || mine ? `${name}: ${text}` : text;
}

/** Every conversation on this phone: each circle's group chat and your direct chats. */
export default function Chats() {
  const t = useTheme();
  const clients = useAllCircles();
  // The circle on screen (for its helper's lists and reminders).
  const active = clients.length ? getClient() : null;
  const { showPlaceAlerts } = useSettings();
  const [picking, setPicking] = useState(false);
  const lastOf = (c: CircleClient, peer: string | null) => c.conversation(peer).filter((m) => showPlaceAlerts || m.kind !== 'event').at(-1);
  const multi = clients.length > 1;

  const rows: Row[] = clients.flatMap((c) => {
    if (!c.circleId) return [];
    const group: Row = {
      key: c.circleId,
      client: c,
      peer: null,
      title: c.circle.name,
      subtitle: `Group · ${c.memberList().length} ${c.memberList().length === 1 ? 'member' : 'members'}`,
      color: null,
      last: lastOf(c, null),
      unread: unreadIn(c, null),
    };
    // Direct chats: if the circle has them, the helper's own chat, and check-ins (which come as direct messages).
    const dmOn = (peer: string) => (peer === c.agent?.id ? c.feature('agent') : c.feature('directMessages') || c.feature('checkIns'));
    const dms = c.directPeers().filter(dmOn).map((peer): Row => {
      const m = c.members.get(peer);
      return {
        key: `${c.circleId}:${peer}`,
        client: c,
        peer,
        title: m?.name || 'Former member',
        subtitle: multi ? `Direct · ${c.circle.name}` : 'Direct message',
        color: m?.color || t.muted,
        last: lastOf(c, peer),
        unread: unreadIn(c, peer),
      };
    });
    return [...(c.feature('groupChat') ? [group] : []), ...dms];
  });
  rows.sort((a, b) => (b.last?.seq ?? 0) - (a.last?.seq ?? 0));

  const open = (client: CircleClient, peer: string | null) => {
    setPicking(false);
    router.push({ pathname: '/conversation', params: { circle: client.circleId!, peer: peer ?? '' } });
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top']}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 10, paddingBottom: 6 }}>
        <Text style={{ flex: 1, color: t.text, fontSize: 30, fontWeight: '800' }}>Chats</Text>
        <Button title="New message" variant="primary" small onPress={() => setPicking(true)} />
      </View>
      <ServerBanner style={{ marginHorizontal: 16, marginBottom: 6 }} />
      {/* The helper's shopping lists and reminders, for the circle on screen. */}
      {active?.agent && (active.feature('shoppingLists') || active.feature('reminders')) ? (
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
          {active.feature('shoppingLists') ? <Shortcut icon="🛒" label="Shopping lists" onPress={() => router.push('/lists')} /> : null}
          {active.feature('reminders') ? <Shortcut icon="⏰" label="Reminders" onPress={() => router.push('/reminders')} /> : null}
        </View>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        contentContainerStyle={{ paddingBottom: 24 }}
        renderItem={({ item: r }) => (
          <Pressable
            onPress={() => open(r.client, r.peer)}
            accessibilityRole="button"
            accessibilityLabel={`${r.title}, ${r.subtitle}${r.unread ? `, ${r.unread} unread` : ''}`}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 14,
              paddingHorizontal: 16,
              paddingVertical: 12,
              minHeight: 80,
              backgroundColor: pressed ? t.surface2 : 'transparent',
            })}
          >
            {r.peer ? (
              <Avatar name={r.title} color={r.color!} size={52} />
            ) : (
              <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: t.brand, fontWeight: '800', fontSize: 18 }}>{initials(r.title)}</Text>
              </View>
            )}
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ flex: 1, color: t.text, fontSize: 17, fontWeight: '700' }} numberOfLines={1}>
                  {r.title}
                </Text>
                {r.last ? <Text style={{ color: r.unread ? t.brand : t.muted, fontSize: 13 }}>{when(r.last.createdAt)}</Text> : null}
              </View>
              <Text style={{ color: t.muted, fontSize: 12, marginTop: 1 }} numberOfLines={1}>
                {r.subtitle}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 }}>
                <Text style={{ flex: 1, color: r.unread ? t.text : t.muted, fontSize: 15, fontWeight: r.unread ? '600' : '400' }} numberOfLines={1}>
                  {preview(r.client, r.last, !r.peer)}
                </Text>
                {r.unread ? (
                  <View style={{ minWidth: 24, height: 24, borderRadius: 12, backgroundColor: t.brand, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7 }}>
                    <Text style={{ color: t.brandInk, fontSize: 13, fontWeight: '700' }}>{r.unread > 99 ? '99+' : r.unread}</Text>
                  </View>
                ) : null}
              </View>
            </View>
          </Pressable>
        )}
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: t.line, marginLeft: 82 }} />}
      />

      <Modal visible={picking} animationType="slide" transparent onRequestClose={() => setPicking(false)}>
        <Pressable onPress={() => setPicking(false)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' }}>
          <Pressable onPress={() => {}} style={{ backgroundColor: t.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: '80%' }}>
            <SafeAreaView edges={['bottom']}>
              <View style={{ flexDirection: 'row', alignItems: 'center', padding: 18, paddingBottom: 8 }}>
                <Text style={{ flex: 1, color: t.text, fontSize: 20, fontWeight: '700' }}>New message</Text>
                <Button small title="Cancel" onPress={() => setPicking(false)} />
              </View>
              <ScrollView contentContainerStyle={{ paddingBottom: 16 }}>
                {clients.map((c) => {
                  const others = c.memberList().filter((m) => !m.isMe);
                  return (
                    <View key={c.accountKey}>
                      <Text style={{ color: t.muted, fontSize: 13, fontWeight: '700', marginHorizontal: 18, marginTop: 12, marginBottom: 4 }}>
                        {c.circle.name.toUpperCase()}
                      </Text>
                      {c.feature('groupChat') ? <PickRow title={`Everyone in ${c.circle.name}`} subtitle="Group chat" onPress={() => open(c, null)} /> : null}
                      {(c.feature('directMessages') ? others : []).map((m) => (
                        <PickRow key={m.id} title={m.name} subtitle="Direct message" color={m.color} onPress={() => open(c, m.id)} />
                      ))}
                      {others.length ? null : <Text style={{ color: t.muted, marginHorizontal: 18, fontSize: 14 }}>No one else here yet.</Text>}
                    </View>
                  );
                })}
              </ScrollView>
            </SafeAreaView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function Shortcut({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingHorizontal: 14, borderRadius: 14, backgroundColor: pressed ? t.surface2 : t.surface, borderWidth: 1, borderColor: t.line })}
    >
      <Text style={{ fontSize: 20 }}>{icon}</Text>
      <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

function PickRow({ title, subtitle, color, onPress }: { title: string; subtitle: string; color?: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18, minHeight: 64, backgroundColor: pressed ? t.surface2 : 'transparent' })}
    >
      {color ? (
        <Avatar name={title} color={color} size={44} />
      ) : (
        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: t.brand, fontWeight: '800' }}>#</Text>
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontSize: 17, fontWeight: '600' }}>{title}</Text>
        <Text style={{ color: t.muted, fontSize: 13 }}>{subtitle}</Text>
      </View>
    </Pressable>
  );
}
