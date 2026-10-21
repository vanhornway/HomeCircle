import { useCallback, useEffect, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppState, FlatList, Keyboard, KeyboardAvoidingView, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { EMOJI_GROUPS, QUICK_REACTIONS, isEmojiOnly, type CircleClient, type Message } from '@homecircle/core';
import { Avatar, Button, Icon, IconButton } from '../components/ui';
import { locatePerson, locateState, openDirections, useLocateVersion } from '../lib/people';
import { shareNow } from '../lib/location';
import { ServerBanner } from '../components/ServerBanner';
import { clientForCircle, errorText, useCircles } from '../lib/circle';
import { initials } from '../lib/useCircle';
import { setVisibleConversation } from '../lib/notify';
import { conversationKey, markRead } from '../lib/unread';
import { useSettings } from '../lib/storage';
import { useTheme } from '../theme';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** One conversation: a circle's group chat, or a direct chat with one member (`peer`). */
export default function ConversationScreen() {
  const { circle, peer } = useLocalSearchParams<{ circle: string; peer?: string }>();
  useCircles();
  const client = clientForCircle(circle);
  if (!client?.account) {
    return <Gone />;
  }
  return <Conversation key={`${circle}:${peer || ''}`} client={client} peer={peer || null} />;
}

function Gone() {
  const t = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg, padding: 24, gap: 16 }}>
      <Text style={{ color: t.text, fontSize: 18 }}>This conversation isn’t on this phone anymore.</Text>
      <Button title="Back to chats" onPress={() => router.back()} />
    </SafeAreaView>
  );
}

function useClientEvents(client: CircleClient) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const offs = ['messages', 'members', 'circle', 'locations', 'status'].map((e) => client.on(e, bump));
    return () => offs.forEach((off) => off());
  }, [client]);
}

function Conversation({ client, peer }: { client: CircleClient; peer: string | null }) {
  const t = useTheme();
  useClientEvents(client);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reactingTo, setReactingTo] = useState<Message | null>(null);
  const [checkingIn, setCheckingIn] = useState<string | null>(null);
  useLocateVersion();
  const list = useRef<FlatList<Message>>(null);
  const me = client.account?.memberId;
  const key = conversationKey(client.circleId!, peer);
  const other = peer ? client.members.get(peer) : null;
  const { showPlaceAlerts } = useSettings();
  const all = client.conversation(peer).filter((m) => showPlaceAlerts || m.kind !== 'event');
  const messages = [...all].reverse();
  const lastSeq = all.at(-1)?.seq ?? 0;

  // While this conversation is on screen it's read, and doesn't notify.
  useFocusEffect(
    useCallback(() => {
      setVisibleConversation(key);
      return () => setVisibleConversation(null);
    }, [key]),
  );
  useEffect(() => {
    if (AppState.currentState === 'active') markRead(client, peer).catch(() => {});
  }, [client, peer, lastSeq]);

  const send = async () => {
    const value = text;
    if (!value.trim()) return;
    setText('');
    setError(null);
    try {
      await client.sendChat(value, { to: peer });
      list.current?.scrollToOffset({ offset: 0, animated: true });
    } catch (e) {
      setText(value);
      setError(errorText(e));
    }
  };

  const react = (messageId: string, emoji: string) => {
    setReactingTo(null);
    client.react(messageId, emoji).catch((e) => setError(errorText(e)));
  };

  // Check-ins: a "where are you?" from them that you haven't answered yet.
  const answered = (req: Message) => all.some((x) => x.from === me && x.body?.checkin === 'ok' && x.seq > req.seq);
  const answer = async (req: Message) => {
    if (!peer) return;
    setCheckingIn(req.id);
    try {
      await client.checkIn(peer);
      shareNow('manual').catch(() => {});
    } catch (e) {
      setError(errorText(e));
    } finally {
      setCheckingIn(null);
    }
  };
  const ask = () => {
    if (peer) client.askToCheckIn(peer).catch((e) => setError(errorText(e)));
  };
  const peerLoc = peer ? client.locations.get(peer) : undefined;
  const locState = peer ? locateState(client, peer) : 'idle';

  const title = peer ? other?.name || 'Former member' : client.circle.name;
  const subtitle = peer
    ? `Direct message · ${client.circle.name} · end-to-end encrypted`
    : `Group · ${plural(client.memberList().length, 'member')} · end-to-end encrypted`;

  const render = ({ item: m }: { item: Message }) => {
    const who = client.members.get(m.from);
    const name = who?.name || 'Former member';
    if (m.kind !== 'chat') {
      const label =
        m.kind === 'event'
          ? `${name} ${m.body?.action === 'left' ? 'left' : 'arrived at'} ${m.body?.placeName || 'a place'} · ${clock(m.ts)}`
          : '🔒 Sent before you joined';
      return (
        <Text style={{ alignSelf: 'center', color: t.muted, backgroundColor: t.surface2, fontSize: 14, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, overflow: 'hidden', marginVertical: 4 }}>
          {label}
        </Text>
      );
    }
    const mine = m.from === me;
    const big = isEmojiOnly(m.body?.text);
    const reactions = client.reactionsFor(m.id);
    return (
      <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', alignItems: mine ? 'flex-end' : 'flex-start', maxWidth: '82%', marginVertical: 3 }}>
        {!mine && !peer ? <Text style={{ color: who?.color || t.muted, fontSize: 13, fontWeight: '700', marginLeft: 4, marginBottom: 2 }}>{name}</Text> : null}
        <Pressable
          onLongPress={() => {
            Keyboard.dismiss();
            setReactingTo(m);
          }}
          delayLongPress={300}
          accessibilityHint="Long-press to react"
          style={({ pressed }) => ({
            backgroundColor: big ? 'transparent' : mine ? t.brand : t.surface,
            borderRadius: 18,
            paddingHorizontal: big ? 2 : 14,
            paddingVertical: big ? 0 : 10,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          <Text style={big ? { fontSize: 44, lineHeight: 54 } : { color: mine ? t.brandInk : t.text, fontSize: 17, lineHeight: 23 }}>{m.body?.text}</Text>
        </Pressable>
        {m.body?.checkin === 'request' && !mine && peer ? (
          answered(m) ? (
            <Text style={{ color: t.brand, fontSize: 14, fontWeight: '600', marginTop: 4, marginLeft: 4 }}>✓ You checked in</Text>
          ) : (
            <Button small variant="primary" title="I’m OK" loading={checkingIn === m.id} onPress={() => answer(m)} style={{ marginTop: 6 }} />
          )
        ) : null}
        {reactions.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4, justifyContent: mine ? 'flex-end' : 'flex-start' }}>
            {reactions.map((r) => (
              <Pressable
                key={r.emoji}
                onPress={() => react(m.id, r.emoji)}
                hitSlop={6}
                accessibilityLabel={`${r.emoji} from ${r.names.join(', ')}${r.mine ? '. Tap to remove yours' : '. Tap to add yours'}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  minHeight: 32,
                  paddingHorizontal: 10,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: r.mine ? t.brand : t.line,
                  backgroundColor: r.mine ? t.brandSoft : t.surface,
                }}
              >
                <Text style={{ fontSize: 16 }}>{r.emoji}</Text>
                {r.count > 1 ? <Text style={{ fontSize: 13, color: r.mine ? t.brand : t.muted, fontWeight: '600' }}>{r.count}</Text> : null}
              </Pressable>
            ))}
          </View>
        ) : null}
        <Text style={{ color: t.muted, fontSize: 12, marginTop: 2, marginHorizontal: 6 }}>{clock(m.ts)}</Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top']}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.line }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: t.brand, fontSize: 34, lineHeight: 36, marginTop: -4 }}>‹</Text>
        </Pressable>
        {peer ? (
          <Avatar name={title} color={other?.color || t.muted} size={40} />
        ) : (
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: t.brand, fontWeight: '700' }}>{initials(title)}</Text>
          </View>
        )}
        <View style={{ flex: 1, marginLeft: 6 }}>
          <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }} numberOfLines={1}>
            {title}
          </Text>
          <Text style={{ color: t.muted, fontSize: 13 }} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        {peer && other && !other.removed ? (
          <View style={{ flexDirection: 'row', gap: 6, marginRight: 6 }}>
            <IconButton
              icon="navigate"
              label={`Directions to ${title}`}
              disabled={!peerLoc}
              onPress={() => peerLoc && openDirections(title, peerLoc, () => locatePerson(client, peer))}
            />
            <IconButton
              icon="locate"
              label={`Locate ${title}`}
              busy={locState === 'asking'}
              done={locState === 'updated'}
              disabled={locState === 'cooldown' || client.paused.has(peer)}
              onPress={() => locatePerson(client, peer)}
            />
            <IconButton icon="checkin" label={`Ask ${title} to check in`} onPress={ask} />
          </View>
        ) : null}
      </View>
      <ServerBanner style={{ marginHorizontal: 12, marginTop: 10 }} />
      {/* Android draws edge to edge, so the window doesn't shrink for the keyboard: pad on both platforms. */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        {messages.length ? null : (
          <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
            <Text style={{ color: t.muted, textAlign: 'center', fontSize: 15 }}>
              {peer ? `Only you and ${title} can read this conversation.` : 'No messages yet. Say hi 👋'}
            </Text>
          </View>
        )}
        <FlatList
          style={messages.length ? undefined : { display: 'none' }}
          ref={list}
          inverted
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={render}
          contentContainerStyle={{ padding: 14 }}
          keyboardShouldPersistTaps="handled"
        />
        {error ? <Text style={{ color: t.danger, paddingHorizontal: 16, fontSize: 15 }}>{error}</Text> : null}
        <SafeAreaView edges={['bottom']} style={{ backgroundColor: t.surface }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: t.line }}>
            <Pressable
              accessibilityLabel={pickerOpen ? 'Hide emoji' : 'Emoji'}
              onPress={() => {
                if (!pickerOpen) Keyboard.dismiss();
                setPickerOpen((v) => !v);
              }}
              style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: pickerOpen ? t.brandSoft : 'transparent' }}
            >
              <Text style={{ fontSize: 26 }}>😊</Text>
            </Pressable>
            <TextInput
              value={text}
              onChangeText={setText}
              onFocus={() => setPickerOpen(false)}
              placeholder={peer ? `Message ${title}` : 'Message your circle'}
              placeholderTextColor={t.muted}
              multiline
              maxLength={4000}
              style={{ flex: 1, minHeight: 48, maxHeight: 130, backgroundColor: t.bg, borderRadius: 24, paddingHorizontal: 16, paddingTop: 13, paddingBottom: 13, fontSize: 17, color: t.text }}
            />
            <Pressable
              accessibilityLabel="Send"
              onPress={send}
              disabled={!text.trim()}
              style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: t.brand, alignItems: 'center', justifyContent: 'center', opacity: text.trim() ? 1 : 0.5 }}
            >
              <Icon name="send" color={t.brandInk} size={22} />
            </Pressable>
          </View>
          {pickerOpen ? (
            <ScrollView style={{ maxHeight: 280, backgroundColor: t.surface }} contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 16 }} keyboardShouldPersistTaps="handled">
              {EMOJI_GROUPS.map((g) => (
                <View key={g.name}>
                  <Text style={{ color: t.muted, fontSize: 13, fontWeight: '700', marginTop: 10, marginBottom: 4, marginLeft: 4 }}>{g.name}</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                    {g.emojis.map((e) => (
                      <Pressable
                        key={e}
                        accessibilityLabel={`Insert ${e}`}
                        onPress={() => setText((v) => v + e)}
                        style={({ pressed }) => ({ width: '12.5%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: pressed ? t.surface2 : 'transparent' })}
                      >
                        <Text style={{ fontSize: 28 }}>{e}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ))}
            </ScrollView>
          ) : null}
        </SafeAreaView>
      </KeyboardAvoidingView>

      <Modal visible={!!reactingTo} transparent animationType="fade" onRequestClose={() => setReactingTo(null)}>
        <Pressable onPress={() => setReactingTo(null)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          {reactingTo ? (
            <View style={{ backgroundColor: t.surface, borderRadius: 20, padding: 16, alignItems: 'center', gap: 12, maxWidth: 380 }}>
              <Text style={{ color: t.muted, fontSize: 15 }} numberOfLines={2}>
                React to “{reactingTo.body?.text}”
              </Text>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {QUICK_REACTIONS.map((e) => {
                  const mine = client.reactionsFor(reactingTo.id).some((r) => r.emoji === e && r.mine);
                  return (
                    <Pressable
                      key={e}
                      accessibilityLabel={mine ? `Remove ${e}` : `React ${e}`}
                      onPress={() => react(reactingTo.id, e)}
                      style={{ width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: mine ? t.brandSoft : t.surface2 }}
                    >
                      <Text style={{ fontSize: 28 }}>{e}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
