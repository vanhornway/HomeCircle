import { useCallback, useEffect, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, AppState, FlatList, Keyboard, KeyboardAvoidingView, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { EMOJI_GROUPS, QUICK_REACTIONS, isEmojiOnly, type CircleClient, type Message } from '@homecircle/core';
import { Avatar, Button, Icon, IconButton } from '../components/ui';
import { canLocate, isAsking, locatePerson, locateState, openDirections, useLocateVersion } from '../lib/people';
import { shareNow } from '../lib/location';
import { ServerBanner } from '../components/ServerBanner';
import { PollCard } from '../components/PollCard';
import { CreatePoll } from '../components/CreatePoll';
import { LinkedText } from '../components/LinkedText';
import { pickDocument, pickPhoto } from '../lib/upload';
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
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const offs = ['messages', 'members', 'circle', 'locations', 'status', 'receipts'].map((e) => client.on(e, bump));
    return () => offs.forEach((off) => off());
  }, [client]);
  return tick;
}

function Conversation({ client, peer }: { client: CircleClient; peer: string | null }) {
  const t = useTheme();
  const tick = useClientEvents(client);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The circle's agent: asked with "/Name …", the 🤖 button, or in its own chat.
  const agent = client.agent;
  const withAgent = !!agent && peer === agent.id;
  const [asking, setAsking] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [reactingTo, setReactingTo] = useState<Message | null>(null);
  // Lists from the agent (dates in a PDF) answered on this screen: no buttons twice.
  const [savedLists, setSavedLists] = useState<Set<string>>(() => new Set());
  const [checkingIn, setCheckingIn] = useState<string | null>(null);
  // Sending the helper a photo or file: the 📎 choices, and the file on its way.
  const [attachOpen, setAttachOpen] = useState(false);
  const [sendingFile, setSendingFile] = useState<string | null>(null);
  const canAttach = !!agent && (withAgent || (!peer && asking));
  useLocateVersion();
  const list = useRef<FlatList<ChatRow>>(null);
  const me = client.account?.memberId;
  const key = conversationKey(client.circleId!, peer);
  const other = peer ? client.members.get(peer) : null;
  const { showPlaceAlerts, readReceipts } = useSettings();
  const all = client.conversation(peer).filter((m) => showPlaceAlerts || m.kind !== 'event');
  // More than MOVEMENT_RUN arrived/left alerts in a row fold into one
  // "Movement" row, so they don't take over the screen. Tap to open it.
  const [openRuns, setOpenRuns] = useState<Set<string>>(() => new Set());
  const rows = [...chatRows(all)].reverse();
  const lastSeq = all.at(-1)?.seq ?? 0;

  // While this conversation is on screen it's read, and doesn't notify.
  useFocusEffect(
    useCallback(() => {
      setVisibleConversation(key);
      return () => setVisibleConversation(null);
    }, [key]),
  );
  useEffect(() => {
    if (AppState.currentState !== 'active') return;
    markRead(client, peer).catch(() => {});
    // Tell the others you've read up to here (unless you turned read receipts off).
    const lastIn = all.filter((x) => x.kind === 'chat' && x.from !== me).at(-1);
    if (readReceipts && lastIn) client.sendReadReceipt(peer, lastIn.seq).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per new message, not on every render
  }, [client, peer, lastSeq, readReceipts]);

  const send = async () => {
    const value = text;
    if (!value.trim()) return;
    setText('');
    setError(null);
    try {
      const question = agent && !peer ? agentQuestion(value, agent.name) : null;
      if (withAgent) await client.askAgent(value, { peer });
      else if (agent && !peer && (asking || question != null)) {
        await client.askAgent(question ?? value);
        setAsking(false);
      } else await client.sendChat(value, { to: peer });
      list.current?.scrollToOffset({ offset: 0, animated: true });
    } catch (e) {
      setText(value);
      setError(errorText(e));
    }
  };

  const attach = async (from: 'camera' | 'library' | 'file') => {
    setAttachOpen(false);
    setError(null);
    try {
      const picked = from === 'file' ? await pickDocument() : await pickPhoto(from);
      if (!picked) return;
      setSendingFile(picked.name);
      await client.sendFileToAgent(picked.bytes, { name: picked.name, mime: picked.mime }, { peer: withAgent ? peer : null });
      setAsking(false);
      list.current?.scrollToOffset({ offset: 0, animated: true });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSendingFile(null);
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

  const eventLabel = (m: Message) =>
    `${client.members.get(m.from)?.name || 'Former member'} ${m.body?.action === 'left' ? 'left' : 'arrived at'} ${m.body?.placeName || 'a place'} · ${clock(typeof m.body?.at === 'number' ? m.body.at : m.ts)}`;
  const pill = { alignSelf: 'center', color: t.muted, backgroundColor: t.surface2, fontSize: 14, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, overflow: 'hidden', marginVertical: 4 } as const;

  const renderRow = ({ item }: { item: ChatRow }) => {
    if (item.type === 'message') return render(item.m);
    const open = openRuns.has(item.id);
    const toggle = () =>
      setOpenRuns((prev) => {
        const next = new Set(prev);
        if (open) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
    return (
      <View style={{ alignItems: 'center' }}>
        <Pressable
          onPress={toggle}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`Movement: ${item.events.length} arrivals and departures. ${open ? 'Tap to hide' : 'Tap to show'}`}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          <Text style={[pill, { color: t.text, fontWeight: '600' }]}>
            {open ? '▴' : '▾'} Movement · {item.events.length}
          </Text>
        </Pressable>
        {open
          ? item.events.map((m) => (
              <Text key={m.id} style={pill}>
                {eventLabel(m)}
              </Text>
            ))
          : null}
      </View>
    );
  };

  const render = (m: Message) => {
    const who = client.members.get(m.from);
    const name = who?.name || 'Former member';
    if (m.kind !== 'chat') {
      return <Text style={pill}>{m.kind === 'event' ? eventLabel(m) : '🔒 Sent before you joined'}</Text>;
    }
    // Poll results and spins read as a line across the chat, like alerts.
    if (m.body?.pollResult || m.body?.pollSpin) return <Text style={[pill, { color: t.text }]}>{m.body.text}</Text>;
    const mine = m.from === me;
    if (m.body?.poll) {
      return (
        <View style={{ marginVertical: 3 }}>
          <PollCard client={client} pollId={m.id} />
          <Text style={{ color: t.muted, fontSize: 12, marginHorizontal: 6, alignSelf: mine ? 'flex-end' : 'flex-start' }}>{clock(m.ts)}</Text>
        </View>
      );
    }
    const big = isEmojiOnly(m.body?.text);
    const reactions = client.reactionsFor(m.id);
    return (
      <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', alignItems: mine ? 'flex-end' : 'flex-start', maxWidth: '82%', marginVertical: 3 }}>
        {!mine && !peer ? (
          <Text style={{ color: who?.kind === 'agent' ? t.brand : who?.color || t.muted, fontSize: 13, fontWeight: '700', marginLeft: 4, marginBottom: 2 }}>
            {who?.kind === 'agent' ? `🤖 ${name}` : name}
          </Text>
        ) : null}
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
          {big ? (
            <Text style={{ fontSize: 44, lineHeight: 54 }}>{m.body?.text}</Text>
          ) : (
            <LinkedText text={String(m.body?.text ?? '')} style={{ color: mine ? t.brandInk : t.text, fontSize: 17, lineHeight: 23 }} linkColor={mine ? t.brandInk : t.brand} />
          )}
        </Pressable>
        {who?.kind === 'agent' && Array.isArray(m.body?.undo) && m.body.undo.length ? (
          <Button small title="Undo" onPress={() => client.undoAgent(m.body!.undo, { peer }).catch((e) => setError(errorText(e)))} style={{ marginTop: 6 }} />
        ) : null}
        {who?.kind === 'agent' && m.body?.save?.by === me && typeof m.body.save.id === 'string' && !savedLists.has(m.body.save.id) ? (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
            {[true, false].map((ok) => (
              <Button
                key={String(ok)}
                small
                variant={ok ? 'primary' : undefined}
                title={ok ? 'Save' : 'Discard'}
                onPress={() => {
                  const id = m.body!.save.id as string;
                  setSavedLists((s) => new Set(s).add(id));
                  client.saveAgentFound(id, ok, { peer }).catch((e) => setError(errorText(e)));
                }}
              />
            ))}
          </View>
        ) : null}
        {who?.kind === 'agent' && m.body?.fileChoice?.by === me && typeof m.body.fileChoice.id === 'string' && !savedLists.has(m.body.fileChoice.id) ? (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
            {[false, true].map((keep) => (
              <Button
                key={String(keep)}
                small
                variant={keep ? undefined : 'primary'}
                title={keep ? 'Keep it' : 'Delete file'}
                onPress={() => {
                  const id = m.body!.fileChoice.id as string;
                  setSavedLists((s) => new Set(s).add(id));
                  client.answerAgentFile(id, keep, { peer }).catch((e) => setError(errorText(e)));
                }}
              />
            ))}
          </View>
        ) : null}
        {m.body?.nudge === true && !mine ? (
          <Button small variant="primary" title="Open setup check" onPress={() => router.push('/setup-check')} style={{ marginTop: 6 }} />
        ) : null}
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
        <Text style={{ color: t.muted, fontSize: 12, marginTop: 2, marginHorizontal: 6 }}>
          {clock(m.ts)}
          {mine ? <Ticks state={client.receipt(m)} showRead={readReceipts} /> : null}
        </Text>
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
              busy={isAsking(locState)}
              done={locState === 'updated'}
              disabled={!canLocate(locState) || client.paused.has(peer)}
              onPress={() => locatePerson(client, peer)}
            />
            <IconButton icon="checkin" label={`Ask ${title} to check in`} onPress={ask} />
          </View>
        ) : null}
      </View>
      <ServerBanner style={{ marginHorizontal: 12, marginTop: 10 }} />
      {/* Android draws edge to edge, so the window doesn't shrink for the keyboard: pad on both platforms. */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        {rows.length ? null : (
          <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
            <Text style={{ color: t.muted, textAlign: 'center', fontSize: 15 }}>
              {peer ? `Only you and ${title} can read this conversation.` : 'No messages yet. Say hi 👋'}
            </Text>
          </View>
        )}
        <FlatList
          style={rows.length ? undefined : { display: 'none' }}
          ref={list}
          inverted
          data={rows}
          extraData={tick}
          keyExtractor={(r) => (r.type === 'message' ? r.m.id : r.id)}
          renderItem={renderRow}
          contentContainerStyle={{ padding: 14 }}
          keyboardShouldPersistTaps="handled"
        />
        {error ? <Text style={{ color: t.danger, paddingHorizontal: 16, fontSize: 15 }}>{error}</Text> : null}
        {sendingFile ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 6 }}>
            <ActivityIndicator color={t.brand} />
            <Text style={{ color: t.muted, fontSize: 14 }}>Sending {sendingFile}, encrypted…</Text>
          </View>
        ) : null}
        {attachOpen && agent ? (
          <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: t.surface, borderTopWidth: 1, borderTopColor: t.line }}>
            {(
              [
                ['camera', '📷', 'Take a photo'],
                ['library', '🖼️', 'Choose a photo'],
                ['file', '📄', 'PDF, doc or sheet'],
              ] as const
            ).map(([from, icon, label]) => (
              <Pressable
                key={from}
                accessibilityRole="button"
                onPress={() => attach(from)}
                style={({ pressed }) => ({ flex: 1, minHeight: 64, borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: 2, backgroundColor: pressed ? t.surface2 : t.bg })}
              >
                <Text style={{ fontSize: 22 }}>{icon}</Text>
                <Text style={{ color: t.text, fontSize: 13, fontWeight: '600', textAlign: 'center' }}>{label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
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
            {agent && !peer && !text.trim() ? (
              <Pressable
                accessibilityLabel={asking ? `Stop asking ${agent.name}` : `Ask ${agent.name}`}
                accessibilityState={{ selected: asking }}
                onPress={() => setAsking((v) => !v)}
                style={{ width: 40, height: 48, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginLeft: -6, backgroundColor: asking ? t.brandSoft : 'transparent' }}
              >
                <Text style={{ fontSize: 24 }}>🤖</Text>
              </Pressable>
            ) : null}
            {canAttach && !text.trim() ? (
              <Pressable
                accessibilityLabel={`Send ${agent!.name} a photo or file`}
                accessibilityState={{ expanded: attachOpen }}
                disabled={!!sendingFile}
                onPress={() => {
                  Keyboard.dismiss();
                  setPickerOpen(false);
                  setAttachOpen((v) => !v);
                }}
                style={{ width: 40, height: 48, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginLeft: -6, backgroundColor: attachOpen ? t.brandSoft : 'transparent' }}
              >
                <Text style={{ fontSize: 22 }}>📎</Text>
              </Pressable>
            ) : null}
            {text.trim() || withAgent || canAttach ? null : (
              <Pressable
                accessibilityLabel="New poll"
                onPress={() => {
                  Keyboard.dismiss();
                  setPickerOpen(false);
                  setPollOpen(true);
                }}
                style={{ width: 40, height: 48, alignItems: 'center', justifyContent: 'center', marginLeft: -6 }}
              >
                <Text style={{ fontSize: 24 }}>📊</Text>
              </Pressable>
            )}
            <TextInput
              value={text}
              onChangeText={setText}
              onFocus={() => setPickerOpen(false)}
              placeholder={withAgent ? `Ask ${title} anything` : asking && agent ? `Ask ${agent.name}…` : peer ? `Message ${title}` : 'Message your circle'}
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
          {agent && !peer && /^\/\S*$/.test(text) && `/${agent.name}`.toLowerCase().startsWith(text.toLowerCase()) ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setText(`/${agent.name} `)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 10, marginBottom: 8, padding: 10, borderRadius: 12, backgroundColor: t.brandSoft }}
            >
              <Text style={{ fontSize: 18 }}>🤖</Text>
              <Text style={{ color: t.brand, fontSize: 16, fontWeight: '700' }}>/{agent.name}</Text>
              <Text style={{ color: t.muted, fontSize: 13 }}>ask the circle’s helper</Text>
            </Pressable>
          ) : null}
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

      <CreatePoll
        client={client}
        peer={peer}
        visible={pollOpen}
        onClose={() => setPollOpen(false)}
        onCreated={() => {
          setPollOpen(false);
          list.current?.scrollToOffset({ offset: 0, animated: true });
        }}
      />
      <Modal visible={!!reactingTo} transparent animationType="fade" onRequestClose={() => setReactingTo(null)}>
        <Pressable onPress={() => setReactingTo(null)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          {reactingTo ? (
            <View style={{ backgroundColor: t.surface, borderRadius: 20, padding: 16, alignItems: 'center', gap: 12, maxWidth: 380 }}>
              <Text style={{ color: t.muted, fontSize: 15 }} numberOfLines={2}>
                React to “{reactingTo.body?.text}”
              </Text>
              {reactingTo.from === me && !reactingTo.peer ? <ReadBy receipts={client.receiptsFor(reactingTo)} showRead={readReceipts} /> : null}
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
              {agent && typeof reactingTo.body?.text === 'string' && reactingTo.from !== agent.id ? (
                <Button
                  small
                  title={`📌 Remember with ${agent.name}`}
                  onPress={() => {
                    const id = reactingTo.id;
                    setReactingTo(null);
                    client.rememberWithAgent(id).catch((e) => setError(errorText(e)));
                  }}
                />
              ) : null}
            </View>
          ) : null}
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

/** More than this many arrived/left alerts in a row collapse into "Movement". */
const MOVEMENT_RUN = 5;

type ChatRow = { type: 'message'; m: Message } | { type: 'movement'; id: string; events: Message[] };

/** Messages in order, with long runs of arrived/left alerts folded into one row (keyed by its first alert). */
function chatRows(messages: Message[]): ChatRow[] {
  const rows: ChatRow[] = [];
  let run: Message[] = [];
  const flush = () => {
    if (run.length > MOVEMENT_RUN) rows.push({ type: 'movement', id: `movement:${run[0].id}`, events: run });
    else for (const m of run) rows.push({ type: 'message', m });
    run = [];
  };
  for (const m of messages) {
    if (m.kind === 'event') {
      run.push(m);
      continue;
    }
    flush();
    rows.push({ type: 'message', m });
  }
  flush();
  return rows;
}

/** "/Jarvis when…" or "/agent when…" → "when…" (the question for the agent), else null. */
function agentQuestion(text: string, name: string): string | null {
  const t = text.trim();
  const lower = t.toLowerCase();
  // "/Chirya when…", and commands written "/Chirya/dream".
  for (const tag of [`/${name.toLowerCase()} `, `/${name.toLowerCase()}/`, '/agent ', '/agent/']) {
    if (lower.startsWith(tag)) return t.slice(tag.length).trim() || null;
  }
  return null;
}

/** ✓ sent, ✓✓ delivered, and ✓✓ in colour when read (if you share read receipts). */
function Ticks({ state, showRead }: { state: 'sent' | 'delivered' | 'read'; showRead: boolean }) {
  const t = useTheme();
  const read = state === 'read' && showRead;
  const label = read ? 'Read' : state === 'sent' ? 'Sent' : 'Delivered';
  return (
    <Text accessibilityLabel={label} style={{ color: read ? t.brand : t.muted, fontWeight: '700' }}>
      {'  '}
      {state === 'sent' ? '✓' : '✓✓'}
    </Text>
  );
}

/** For your own group message: who has read it, who has it, who doesn't yet. */
function ReadBy({ receipts, showRead }: { receipts: { read: string[]; delivered: string[]; waiting: string[] }; showRead: boolean }) {
  const t = useTheme();
  const delivered = showRead ? receipts.delivered : [...receipts.read, ...receipts.delivered];
  const line = (label: string, names: string[]) =>
    names.length ? (
      <Text style={{ color: t.text, fontSize: 14 }}>
        <Text style={{ fontWeight: '700' }}>{label}: </Text>
        {names.join(', ')}
      </Text>
    ) : null;
  return (
    <View style={{ alignSelf: 'stretch', gap: 2 }}>
      {showRead ? line('Read by', receipts.read) : null}
      {line('Delivered to', delivered)}
      {line('Not yet', receipts.waiting)}
    </View>
  );
}
