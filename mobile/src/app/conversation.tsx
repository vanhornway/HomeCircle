import { useCallback, useEffect, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, AppState, FlatList, Keyboard, KeyboardAvoidingView, Linking, Modal, Pressable, Text, TextInput, View, type TextInputInstance } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CALLBACK_REPLIES, QUICK_REACTIONS, isEmojiOnly, randomId, type CallbackReply, type CircleClient, type Message } from '@homecircle/core';
import { Avatar, Button, Icon } from '../components/ui';
import { HeaderBar } from '../components/Header';
import { shareNow } from '../lib/location';
import { circleCount, googleMapsUrl, messageSpot, trackerOf } from '../lib/trackers';
import { myTracker, sendOverMesh, unreachable, useMeshOutbox } from '../lib/meshOutbox';
import { meshRadioText } from '../lib/meshRadio';
import { ServerBanner } from '../components/ServerBanner';
import { PollCard } from '../components/PollCard';
import { PlanCard } from '../components/PlanCard';
import { CreatePlan } from '../components/CreatePlan';
import { CallbackCard } from '../components/CallbackCard';
import { GroupCallCard } from '../components/GroupCallCard';
import { ReminderCard } from '../components/ReminderCard';
import { CallButton, GroupCallButton, WhatsAppCallButton } from '../components/CallActions';
import { PersonSheet } from '../components/PersonSheet';
import { HelperAvatar } from '../components/HelperAvatar';
import { MemberAvatar } from '../components/MemberAvatar';
import { REPLY_LABELS, syncCallbackReminders, timeIn } from '../lib/callbacks';
import { canCall, startCall } from '../lib/calls';
import { openChat, showOutcome } from '../lib/whatsapp';
import { CreatePoll } from '../components/CreatePoll';
import { askedText, helperQuestion, isHelperStatusLine, parseHelperReply, type HelperReply } from '../lib/helperChat';
import { LinkedText } from '../components/LinkedText';
import { pickDocument, pickPhoto } from '../lib/upload';
import { clientForCircle, errorText, setActiveCircle, useCircles } from '../lib/circle';
import { initials } from '../lib/useCircle';
import { setVisibleConversation } from '../lib/notify';
import { conversationKey, markRead } from '../lib/unread';
import { useSettings } from '../lib/storage';
import { setChatScale, useChatScale, usePinchZoom } from '../lib/chatZoom';
import { percentLabel, scaled } from '../lib/chatZoomCore';
import { useTheme } from '../theme';

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
    // A reconnect sends a burst of these (circle, members, messages…): redraw
    // the chat once for the burst, not once per event.
    let queued: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (queued) return;
      queued = setTimeout(() => {
        queued = null;
        setTick((n) => n + 1);
      }, 50);
    };
    const offs = ['messages', 'members', 'circle', 'locations', 'status', 'receipts', 'records'].map((e) => client.on(e, bump));
    return () => {
      if (queued) clearTimeout(queued);
      offs.forEach((off) => off());
    };
  }, [client]);
  return tick;
}

function Conversation({ client, peer }: { client: CircleClient; peer: string | null }) {
  const t = useTheme();
  const tick = useClientEvents(client);
  // Pinch the messages to make their text bigger or smaller; remembered on this phone.
  const zoom = useChatScale();
  const fs = (n: number) => scaled(n, zoom);
  const pinch = usePinchZoom();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The circle's agent: asked from the + menu, by starting with its name ("Chirya, …"), or in its own chat.
  const agent = client.feature('agent') ? client.agent : null;
  // Its name for questions asked earlier (it may have been renamed or removed since).
  const helperName = client.agent?.name ?? client.agentInvited?.name ?? '';
  const withAgent = !!agent && peer === agent.id;
  const [asking, setAsking] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [reactingTo, setReactingTo] = useState<Message | null>(null);
  // Lists from the agent (dates in a PDF) answered on this screen: no buttons twice.
  const [savedLists, setSavedLists] = useState<Set<string>>(() => new Set());
  const [checkingIn, setCheckingIn] = useState<string | null>(null);
  // The + menu above the composer, and the file on its way to the helper.
  const [menuOpen, setMenuOpen] = useState(false);
  // Someone's name or photo in the header: the same sheet as on the map.
  const [personOpen, setPersonOpen] = useState(false);
  const input = useRef<TextInputInstance>(null);
  const [sendingFile, setSendingFile] = useState<string | null>(null);
  // Writing here: the circle has this kind of chat (the helper's own chat always works).
  const canWrite = peer ? withAgent || client.feature('directMessages') : client.feature('groupChat');
  const canAttach = !!agent && client.feature('uploads') && (withAgent || !peer);
  const canPoll = !withAgent && client.feature('polls');
  const canAsk = !!agent && !peer;
  const hasMenu = canAsk || canAttach || canPoll;
  const list = useRef<FlatList<ChatRow>>(null);
  const me = client.account?.memberId;
  const key = conversationKey(client.circleId!, peer);
  const other = peer ? client.members.get(peer) : null;
  const settings = useSettings();
  const showPlaceAlerts = settings.showPlaceAlerts;
  // Read ticks: only if the circle has them and you share yours.
  const readReceipts = settings.readReceipts && client.feature('readReceipts');
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

  // With no internet, a short message can go through the tracker this person
  // carries, over the mesh: automatically when the server can't be reached,
  // or always while "over the mesh" is on (the 📡 button).
  const tracker = withAgent ? null : myTracker(client);
  const [viaMesh, setViaMesh] = useState(false);
  const outbox = useMeshOutbox(client, peer);
  const meshMax = peer ? client.meshTextMax.direct : client.meshTextMax.chat;
  const meshLeft = meshMax - new TextEncoder().encode(text.trim()).length;
  useEffect(() => {
    // The mesh key has to reach the server while there's internet.
    if (tracker && !client.meshReady) client.prepareMesh().catch(() => {});
  }, [client, tracker]);

  // A message that didn't go: tried again (same text), it keeps its id, so the server never keeps two.
  const failed = useRef<{ text: string; id: string } | null>(null);
  const send = async () => {
    const value = text;
    if (!value.trim()) return;
    setText('');
    setError(null);
    const msgId = failed.current?.text === value.trim() ? failed.current.id : randomId(12);
    failed.current = null;
    const question = agent && !peer ? helperQuestion(value, agent.name) : null;
    const plain = !withAgent && !(agent && !peer && (asking || question != null));
    if (plain && tracker && viaMesh) {
      try {
        await sendOverMesh(client, value, peer, msgId);
      } catch (e) {
        failed.current = { text: value.trim(), id: msgId };
        setText(value);
        setError(meshRadioText(e, tracker.name));
      }
      return;
    }
    try {
      if (withAgent) await client.askAgent(value, { peer });
      else if (agent && !peer && (asking || question != null)) {
        await client.askAgent(question ?? value);
        setAsking(false);
      } else await client.sendChat(value, { to: peer, id: msgId });
      list.current?.scrollToOffset({ offset: 0, animated: true });
    } catch (e) {
      // No internet: through the tracker instead, if it fits one radio packet.
      if (plain && tracker && unreachable(e) && client.meshReady && client.meshFits(value, peer)) {
        try {
          await sendOverMesh(client, value, peer, msgId);
          return;
        } catch (e2) {
          failed.current = { text: value.trim(), id: msgId };
          setText(value);
          setError(`Couldn’t reach the server, and ${tracker.name} didn’t take it either, so it may not have gone. Tap send to try again (it won’t be sent twice). ${meshRadioText(e2, tracker.name)}`);
          return;
        }
      }
      if (plain && unreachable(e)) failed.current = { text: value.trim(), id: msgId };
      setText(value);
      setError(
        plain && tracker && unreachable(e) && !client.meshFits(value, peer)
          ? `No internet. Over the mesh a message can be at most ${meshMax} bytes: shorten it and tap 📡.`
          : errorText(e),
      );
    }
  };

  const attach = async (from: 'camera' | 'library' | 'file') => {
    setMenuOpen(false);
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
  // A choice from the + menu beside the message box.
  const pickFromMenu = (key: string) => {
    if (key === 'ask') {
      setAsking((v) => !v);
      setMenuOpen(false);
      input.current?.focus();
    } else if (key === 'poll') {
      setMenuOpen(false);
      setPollOpen(true);
    } else if (key === 'plan') {
      setMenuOpen(false);
      setPlanOpen(true);
    } else attach(key as 'camera' | 'library' | 'file');
  };

  const replyCallback = (requestId: string, reply: CallbackReply) => {
    setReactingTo(null);
    client
      .replyCallback(requestId, reply)
      .then(() => syncCallbackReminders(client))
      .catch((e) => setError(errorText(e)));
  };

  // Tap on a call-back card: says "I'm calling you now" so she hears it, then calls. In HomeCircle when that works, otherwise WhatsApp.
  const callBack = (m: Message) => {
    const s = client.callbackState(m.id);
    if (!s) return;
    const phone = client.feature('whatsapp') ? client.phoneOf(s.from) : null;
    const inApp = canCall(client, s.from);
    if (!inApp && !phone) return setReactingTo(m);
    if (!s.takenBy) replyCallback(s.id, 'now');
    if (inApp) startCall(client, s.from).catch((e) => setError(errorText(e)));
    else void openChat(phone!).then(showOutcome);
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
  // The helper's chat starts with a few things to try.
  const tryIt = (starter: string) => {
    setText(starter);
    input.current?.focus();
  };
  const examples = [
    'Remember ',
    'What’s on this week?',
    ...(client.feature('shoppingLists') ? ['Add milk to Costco'] : []),
  ];
  const canOpenPerson = !!peer && !!other && !other.removed && other.kind !== 'agent';

  const title = peer ? (other ? client.displayName(other.id) : 'Former member') : client.circle.name;
  const subtitle = peer
    ? withAgent
      ? 'Helper · end-to-end encrypted'
      : `Direct message · ${client.circle.name} · end-to-end encrypted`
    : `Group · ${circleCount(client)} · end-to-end encrypted`;

  // A question to the helper shows as the person's own words, without the "/Name" it carries.
  const shownText = (m: Message) => {
    const raw = String(m.body?.text ?? '');
    // The internet bridge's settings sent to the home base: don't show its password.
    if (m.peer && /^mqtt \S+ \S+ \S+$/i.test(raw.trim())) return raw.trim().replace(/ \S+$/, ' ••••••');
    return m.body?.agentAsk && !m.peer ? askedText(raw, helperName) : raw;
  };
  const undo = (m: Message) => {
    const key = `undo:${m.id}`;
    setSavedLists((s) => new Set(s).add(key));
    client.undoAgent(m.body!.undo, { peer }).catch((e) => {
      setSavedLists((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
      setError(errorText(e));
    });
  };

  const shareNotes = (m: Message) => {
    const key = `share:${m.id}`;
    setSavedLists((s) => new Set(s).add(key));
    client.shareAgentNotes(m.body!.shareNotes, { peer }).catch((e) => {
      setSavedLists((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
      setError(errorText(e));
    });
  };

  const eventLabel = (m: Message) =>
    `${client.members.get(m.from)?.name || 'Former member'} ${m.body?.action === 'left' ? 'left' : 'arrived at'} ${m.body?.placeName || 'a place'} · ${clock(typeof m.body?.at === 'number' ? m.body.at : m.ts)}`;
  const pill = { alignSelf: 'center', color: t.muted, backgroundColor: t.surface2, fontSize: fs(14), paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, overflow: 'hidden', marginVertical: 4 } as const;
  // Each reminder from the helper: Done goes on its latest message, earlier ones are history.
  // The helper's "✅ … done" says which reminder, and closes the cards sent before it.
  const latestReminder = new Map<string, string>();
  const reminderDoneAt = new Map<string, number>();
  for (const x of all) {
    if (typeof x.body?.reminder?.id === 'string') latestReminder.set(x.body.reminder.id, x.id);
    if (typeof x.body?.reminderDoneId === 'string') reminderDoneAt.set(x.body.reminderDoneId, x.seq);
  }

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
    const name = who ? client.displayName(who.id) : 'Former member';
    if (m.kind !== 'chat') {
      return <Text style={pill}>{m.kind === 'event' ? eventLabel(m) : '🔒 Sent before you joined'}</Text>;
    }
    // Poll results and spins read as a line across the chat, like alerts.
    if (m.body?.pollResult || m.body?.pollSpin) return <Text style={[pill, { color: t.text }]}>{m.body.text}</Text>;
    // Call-back requests from the Elderly Companion app, and the replies (a line each).
    if (!peer && m.body?.callback?.state === 'ask') return <CallbackCard client={client} m={m} onReply={() => setReactingTo(m)} onCall={() => callBack(m)} />;
    if (!peer && m.body?.callback?.state === 'reply') return <Text style={pill}>{String(m.body.text ?? '').replace(/^📞\s*/, '')}</Text>;
    // The WhatsApp group call: a card with Join while it's on, then one line. Joins show on the card, not as lines.
    if (!peer && m.body?.groupCall?.state === 'start') return <GroupCallCard client={client} m={m} />;
    if (!peer && (m.body?.groupCall?.state === 'join' || m.body?.groupCall?.state === 'leave')) return null;
    const fromHelper = who?.kind === 'agent';
    // "↩️ Undone." from the helper: a line, like alerts.
    if (fromHelper && isHelperStatusLine(String(m.body?.text ?? ''))) return <Text style={pill}>{m.body!.text}</Text>;
    const mine = m.from === me;
    if (m.body?.poll) {
      return (
        <View style={{ marginVertical: 3 }}>
          <PollCard client={client} pollId={m.id} />
          <Text style={{ color: t.muted, fontSize: fs(14), marginHorizontal: 6, alignSelf: mine ? 'flex-end' : 'flex-start' }}>{clock(m.ts)}</Text>
        </View>
      );
    }
    if (m.body?.plan && client.planState(m.id)) {
      return (
        <View style={{ marginVertical: 3 }}>
          <PlanCard client={client} planId={m.id} />
          <Text style={{ color: t.muted, fontSize: fs(14), marginHorizontal: 6, alignSelf: mine ? 'flex-end' : 'flex-start' }}>{clock(m.ts)}</Text>
        </View>
      );
    }
    const big = isEmojiOnly(m.body?.text);
    const reactions = client.reactionsFor(m.id);
    // The helper's replies: what it kept is a chip with Undo in it; privacy notes are one short line each.
    const reply: HelperReply | null = fromHelper && typeof m.body?.text === 'string' ? parseHelperReply(m.body.text) : null;
    const toHelper = !!m.body?.agentAsk && !peer;
    const bubbleText = reply ? reply.text : shownText(m);
    const undoable = fromHelper && Array.isArray(m.body?.undo) && m.body.undo.length > 0;
    const undone = savedLists.has(`undo:${m.id}`);
    const longPress = () => {
      Keyboard.dismiss();
      setReactingTo(m);
    };
    // A tracker's message (a button press, an SOS, a Locate answer): tap it to see where it was.
    const spot = !mine && trackerOf(client, m.from) ? messageSpot(client, m.from, m.ts) : null;
    const showSpot = spot
      ? async () => {
          if (client.accountKey) await setActiveCircle(client.accountKey).catch(() => {});
          router.navigate({ pathname: '/', params: { spotLat: String(spot.lat), spotLng: String(spot.lng), spotAt: String(spot.at), spotName: name, spotFor: m.id } });
        }
      : undefined;
    // A reminder from the helper: the same highlighted card as a call-back request.
    const reminderId = who?.kind === 'agent' && typeof m.body?.reminder?.id === 'string' ? (m.body.reminder.id as string) : null;
    return (
      <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', alignItems: mine ? 'flex-end' : 'flex-start', maxWidth: '82%', marginVertical: 3, ...(reminderId ? { width: '84%', maxWidth: undefined, alignItems: 'stretch' } : null) }}>
        {!mine && !peer ? (
          <Text style={{ color: who?.kind === 'agent' ? t.brand : who?.color || t.muted, fontSize: fs(14), fontWeight: '700', marginLeft: 4, marginBottom: 2 }}>
            {who?.kind === 'agent' ? `🐦 ${name}` : name}
          </Text>
        ) : null}
        {reminderId ? (
          <ReminderCard
            m={m}
            state={savedLists.has(reminderId) || (reminderDoneAt.get(reminderId) ?? -1) > m.seq ? 'done' : latestReminder.get(reminderId) === m.id ? 'open' : 'earlier'}
            onLongPress={() => setReactingTo(m)}
            onDone={() => {
              setSavedLists((s) => new Set(s).add(reminderId));
              client.doneAgentReminder(reminderId, { peer }).catch((e) => setError(errorText(e)));
            }}
          />
        ) : bubbleText || !reply?.kept ? (
          <Pressable accessibilityRole="button"
            onPress={showSpot}
            onLongPress={longPress}
            delayLongPress={300}
            accessibilityHint={showSpot ? 'Opens the map where it was. Long-press to react' : 'Long-press to react'}
            style={({ pressed }) => ({
              backgroundColor: big ? 'transparent' : mine ? t.brand : t.surface,
              borderRadius: 18,
              paddingHorizontal: big ? 2 : 14,
              paddingVertical: big ? 0 : 10,
              opacity: pressed ? 0.75 : 1,
            })}
          >
            {toHelper ? (
              <Text style={{ color: mine ? t.brandInk : t.brand, opacity: mine ? 0.8 : 1, fontSize: fs(14), fontWeight: '700', marginBottom: 2 }}>To {helperName || 'the helper'}</Text>
            ) : null}
            {big ? (
              <Text style={{ fontSize: fs(44), lineHeight: fs(54) }}>{m.body?.text}</Text>
            ) : (
              <LinkedText text={bubbleText} style={{ color: mine ? t.brandInk : t.text, fontSize: fs(17), lineHeight: fs(23) }} linkColor={mine ? t.brandInk : t.brand} />
            )}
            {undoable && !reply?.kept ? <UndoLink undone={undone} onPress={() => undo(m)} fs={fs} /> : null}
          </Pressable>
        ) : null}
        {spot ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginTop: 4, marginLeft: 6 }}>
            <Pressable accessibilityRole="link" hitSlop={8} onPress={showSpot} style={{ minHeight: 32, justifyContent: 'center' }}>
              <Text style={{ color: t.brand, fontSize: fs(14), fontWeight: '700' }}>📍 {spot.exact ? 'On the map' : 'Last known spot'}</Text>
            </Pressable>
            <Pressable accessibilityRole="link" hitSlop={8} onPress={() => Linking.openURL(googleMapsUrl(spot.lat, spot.lng)).catch(() => {})} style={{ minHeight: 32, justifyContent: 'center' }}>
              <Text style={{ color: t.brand, fontSize: fs(14), fontWeight: '700' }}>Google Maps</Text>
            </Pressable>
          </View>
        ) : null}
        {reply?.kept ? (
          <KeptChip kept={reply.kept} undoable={undoable} undone={undone} onUndo={() => undo(m)} onLongPress={longPress} fs={fs} style={bubbleText ? { marginTop: 6 } : null} />
        ) : null}
        {reply && (reply.extra.length || reply.notes.length) ? <ReplyNotes reply={reply} fs={fs} /> : null}
        {fromHelper && Array.isArray(m.body?.shareNotes) && m.body.shareNotes.length && !undone && !savedLists.has(`share:${m.id}`) ? (
          <Button small title="Share with the circle" onPress={() => shareNotes(m)} style={{ alignSelf: 'flex-start', marginTop: 6 }} />
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
            <Text style={{ color: t.brand, fontSize: fs(14), fontWeight: '600', marginTop: 4, marginLeft: 4 }}>✓ You checked in</Text>
          ) : (
            <Button small variant="primary" title="I’m OK" loading={checkingIn === m.id} onPress={() => answer(m)} style={{ marginTop: 6 }} />
          )
        ) : null}
        {reactions.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4, justifyContent: mine ? 'flex-end' : 'flex-start' }}>
            {reactions.map((r) => (
              <Pressable accessibilityRole="button"
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
                <Text style={{ fontSize: fs(16) }}>{r.emoji}</Text>
                {r.count > 1 ? <Text style={{ fontSize: fs(14), color: r.mine ? t.brand : t.muted, fontWeight: '600' }}>{r.count}</Text> : null}
              </Pressable>
            ))}
          </View>
        ) : null}
        <Text style={{ color: t.muted, fontSize: fs(14), marginTop: 2, marginHorizontal: 6 }}>
          {clock(m.ts)}
          {m.body?.via === 'radio' && m.body?.sos === undefined ? ' · 📡 over the mesh' : ''}
          {mine ? <Ticks state={client.receipt(m)} showRead={readReceipts} /> : null}
        </Text>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <HeaderBar
        right={
          <>
            {!peer ? <GroupCallButton client={client} /> : null}
            {peer && canOpenPerson ? <CallButton client={client} memberId={peer} /> : null}
          </>
        }
      >
        <Pressable
          disabled={!canOpenPerson}
          onPress={() => setPersonOpen(true)}
          accessibilityRole={canOpenPerson ? 'button' : undefined}
          accessibilityLabel={canOpenPerson ? `${title}. Directions, locate, check in` : undefined}
          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}
        >
          {peer ? (
            withAgent ? (
              <HelperAvatar size={40} />
            ) : other ? (
              <MemberAvatar client={client} member={other} size={40} />
            ) : (
              <Avatar name={title} color={t.muted} size={40} />
            )
          ) : (
            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: t.brand, fontWeight: '700' }}>{initials(title)}</Text>
            </View>
          )}
          <View style={{ flex: 1, marginLeft: 6 }}>
            <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }} numberOfLines={1}>
              {title}
            </Text>
            <Text style={{ color: t.muted, fontSize: 14 }} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
        </Pressable>
      </HeaderBar>
      {/* Android draws edge to edge, so the window doesn't shrink for the keyboard: pad on both platforms. */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        {/* Over the messages, so "Reconnecting…" coming and going doesn't move them. */}
        <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2 }}>
          <ServerBanner style={{ marginHorizontal: 12, marginTop: 10 }} />
        </View>
        {rows.length ? null : (
          <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
            <Text style={{ color: t.muted, textAlign: 'center', fontSize: 15 }}>
              {peer ? `Only you and ${title} can read this conversation.` : 'No messages yet. Say hi 👋'}
            </Text>
            {withAgent ? (
              <View style={{ marginTop: 20, gap: 10, alignItems: 'center' }}>
                <Text style={{ color: t.muted, fontSize: 14, fontWeight: '700' }}>TRY ONE</Text>
                {examples.map((x) => (
                  <Pressable
                    key={x}
                    accessibilityRole="button"
                    accessibilityLabel={`${x.trim()}. Fills the message box`}
                    onPress={() => tryIt(x)}
                    style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 16, borderRadius: 22, borderWidth: 1, borderColor: t.line, backgroundColor: pressed ? t.surface2 : t.surface, justifyContent: 'center' })}
                  >
                    <Text style={{ color: t.text, fontSize: 16 }}>{x.trim() === 'Remember' ? 'Remember…' : x}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        )}
        {/* Two fingers on the messages zoom their text; one finger scrolls, taps and long-presses as before. */}
        <View style={rows.length ? { flex: 1 } : { display: 'none' }} {...pinch.panHandlers}>
          <FlatList
            ref={list}
            inverted
            data={rows}
            extraData={`${tick}:${zoom}`}
            scrollEnabled={!pinch.pinching}
            // Most chats fit: draw the recent ones in one go, so the list isn't re-measured as it redraws.
            initialNumToRender={30}
            maxToRenderPerBatch={30}
            windowSize={31}
            keyExtractor={(r) => (r.type === 'message' ? r.m.id : r.id)}
            renderItem={renderRow}
            contentContainerStyle={{ padding: 14 }}
            keyboardShouldPersistTaps="handled"
          />
          {pinch.showing ? (
            <View pointerEvents="box-none" style={{ position: 'absolute', top: 10, left: 0, right: 0, alignItems: 'center' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 14, paddingRight: 6, minHeight: 44, borderRadius: 22, backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, elevation: 4 }}>
                <Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>Text size {percentLabel(zoom)}</Text>
                {zoom !== 1 ? (
                  <Pressable accessibilityRole="button" accessibilityLabel="Reset text size" onPress={() => setChatScale(1)} style={{ minHeight: 44, paddingHorizontal: 12, borderRadius: 18, justifyContent: 'center', backgroundColor: t.brandSoft }}>
                    <Text style={{ color: t.brand, fontSize: 15, fontWeight: '700' }}>Reset</Text>
                  </Pressable>
                ) : null}
            </View>
          </View>
        ) : null}
        </View>
        {error ? <Text style={{ color: t.danger, paddingHorizontal: 16, fontSize: 15 }}>{error}</Text> : null}
        {sendingFile ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 6 }}>
            <ActivityIndicator color={t.brand} />
            <Text style={{ color: t.muted, fontSize: 14 }}>Sending {sendingFile}, encrypted…</Text>
          </View>
        ) : null}
        {menuOpen && hasMenu ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: t.surface, borderTopWidth: 1, borderTopColor: t.line }}>
            {(
              [
                ...(canAsk ? [{ key: 'ask', icon: '🐦', label: asking ? `Stop asking ${agent!.name}` : `Ask ${agent!.name}`, }] : []),
                ...(canAttach
                  ? [
                      { key: 'camera', icon: '📷', label: 'Take a photo' },
                      { key: 'library', icon: '🖼️', label: 'Choose a photo' },
                      { key: 'file', icon: '📄', label: 'PDF, doc or sheet' },
                    ]
                  : []),
                ...(canPoll ? [{ key: 'poll', icon: '📊', label: 'New poll' }] : []),
                ...(!peer && client.feature('plans') ? [{ key: 'plan', icon: '📅', label: 'New plan' }] : []),
              ] as { key: string; icon: string; label: string }[]
            ).map((item) => (
              <Pressable
                key={item.key}
                accessibilityRole="button"
                onPress={() => pickFromMenu(item.key)}
                style={({ pressed }) => ({ flexBasis: '30%', flexGrow: 1, minHeight: 64, borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: 4, backgroundColor: pressed ? t.surface2 : t.bg })}
              >
                <Text style={{ fontSize: 22 }}>{item.icon}</Text>
                <Text style={{ color: t.text, fontSize: 14, fontWeight: '600', textAlign: 'center' }}>{item.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {!canWrite ? (
          <SafeAreaView edges={['bottom']} style={{ backgroundColor: t.surface, borderTopWidth: 1, borderTopColor: t.line, padding: 14 }}>
            <Text style={{ color: t.muted, fontSize: 14, textAlign: 'center' }}>
              {peer ? 'Direct messages are turned off in this circle.' : 'The group chat is turned off in this circle.'} An admin can turn it on in Settings.
            </Text>
          </SafeAreaView>
        ) : (
          <SafeAreaView edges={['bottom']} style={{ backgroundColor: t.surface, borderTopWidth: 1, borderTopColor: t.line }}>
            {agent && !peer && (asking || helperQuestion(text, agent.name) != null) ? (
              // Who this goes to: the helper (from the + menu, or a message that starts with its name).
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 10, marginTop: 8, paddingLeft: 6, paddingRight: asking ? 0 : 12, minHeight: 36, borderRadius: 18, backgroundColor: t.brandSoft, alignSelf: 'flex-start' }}>
                <HelperAvatar size={26} />
                <Text style={{ color: t.brand, fontSize: 15, fontWeight: '700' }}>To {agent.name}</Text>
                {asking ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={`Stop asking ${agent.name}`} hitSlop={8} onPress={() => setAsking(false)} style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: t.brand, fontSize: 20, lineHeight: 22 }}>×</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10 }}>
              {hasMenu ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={menuOpen ? 'Close menu' : 'More: ask the helper, photos, polls'}
                  accessibilityState={{ expanded: menuOpen }}
                  disabled={!!sendingFile}
                  onPress={() => {
                    Keyboard.dismiss();
                    setMenuOpen((v) => !v);
                  }}
                  style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: menuOpen || asking ? t.brandSoft : t.bg }}
                >
                  <Text style={{ color: t.brand, fontSize: 30, lineHeight: 34, fontWeight: '500' }}>{menuOpen ? '×' : '+'}</Text>
                </Pressable>
              ) : null}
              {tracker ? (
                <Pressable
                  accessibilityRole="switch"
                  accessibilityLabel={`Send over the mesh, through ${tracker.name}`}
                  accessibilityState={{ checked: viaMesh }}
                  onPress={() => setViaMesh((v) => !v)}
                  style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: viaMesh ? t.brandSoft : t.bg, borderWidth: viaMesh ? 2 : 0, borderColor: t.brand }}
                >
                  <Text style={{ fontSize: 22 }}>📡</Text>
                </Pressable>
              ) : null}
              <TextInput accessibilityLabel={viaMesh && tracker ? `Message over the mesh, through ${tracker.name}` : withAgent ? `Ask ${title} anything` : asking && agent ? `Ask ${agent.name}…` : peer ? `Message ${title}` : 'Message your circle'}
                ref={input}
                value={text}
                onChangeText={setText}
                onFocus={() => setMenuOpen(false)}
                placeholder={viaMesh && tracker ? `Over the mesh, through ${tracker.name}` : withAgent ? `Ask ${title} anything` : asking && agent ? `Ask ${agent.name}…` : peer ? `Message ${title}` : 'Message your circle'}
                placeholderTextColor={t.muted}
                multiline
                maxLength={20000}
                style={{ flex: 1, minHeight: 48, maxHeight: 130, backgroundColor: t.bg, borderRadius: 24, paddingHorizontal: 16, paddingTop: 13, paddingBottom: 13, fontSize: 17, color: t.text }}
              />
              <Pressable accessibilityRole="button"
                accessibilityLabel="Send"
                onPress={send}
                disabled={!text.trim() || (viaMesh && !!tracker && meshLeft < 0)}
                style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: t.brand, alignItems: 'center', justifyContent: 'center', opacity: text.trim() && !(viaMesh && tracker && meshLeft < 0) ? 1 : 0.5 }}
              >
                <Icon name="send" color={t.brandInk} size={22} />
              </Pressable>
            </View>
            {viaMesh && tracker ? (
              <Text accessibilityLiveRegion="polite" style={{ color: meshLeft < 0 ? t.danger : t.muted, fontSize: 14, marginHorizontal: 16, marginBottom: 8 }}>
                Over the mesh through {tracker.name}: {meshLeft >= 0 ? `${meshLeft} left` : `${-meshLeft} too many`} (one radio packet holds {meshMax} bytes; emoji and Urdu letters take more than one). The Meshtastic app mustn’t be connected to it.
              </Text>
            ) : null}
            {outbox.length ? (
              <View style={{ marginHorizontal: 12, marginBottom: 8, gap: 4 }}>
                {outbox.map((o) => (
                  <Text key={o.id} style={{ color: t.muted, fontSize: 14 }} numberOfLines={2}>
                    📡 “{o.text}” sent over the mesh through {o.via} at {clock(o.at)}. It shows in the chat when the home base passes it on.
                  </Text>
                ))}
              </View>
            ) : null}
            {agent && !peer && !asking && /^@\S*$/.test(text) && `@${agent.name}`.toLowerCase().startsWith(text.toLowerCase()) ? (
              // "@" and the start of its name: ask it instead.
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setText('');
                  setAsking(true);
                  input.current?.focus();
                }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 10, marginBottom: 8, minHeight: 48, paddingHorizontal: 10, borderRadius: 12, backgroundColor: t.brandSoft }}
              >
                <HelperAvatar size={28} />
                <Text style={{ color: t.brand, fontSize: 16, fontWeight: '700' }}>Ask {agent.name}</Text>
              </Pressable>
            ) : null}
          </SafeAreaView>
        )}
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
      <CreatePlan
        client={client}
        visible={planOpen}
        onClose={() => setPlanOpen(false)}
        onCreated={() => {
          setPlanOpen(false);
          list.current?.scrollToOffset({ offset: 0, animated: true });
        }}
      />
      <Modal visible={!!reactingTo} transparent animationType="fade" onRequestClose={() => setReactingTo(null)}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setReactingTo(null)} style={{ flex: 1, backgroundColor: t.scrim, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          {reactingTo ? (
            <View style={{ backgroundColor: t.surface, borderRadius: 20, padding: 16, alignItems: 'center', gap: 12, maxWidth: 380 }}>
              {(() => {
                const s = reactingTo.body?.callback?.state === 'ask' ? client.callbackState(reactingTo.id) : null;
                if (!s) {
                  return (
                    <Text style={{ color: t.muted, fontSize: 15 }} numberOfLines={2}>
                      React to “{shownText(reactingTo)}”
                    </Text>
                  );
                }
                const canReply = client.callbackAsks(s);
                return (
                  <View style={{ alignSelf: 'stretch', gap: 10 }}>
                    <Text style={{ color: t.muted, fontSize: 15, textAlign: 'center' }}>{canReply ? `Reply to “${s.name} wants a call back”` : `${s.name} asked for a call back`}</Text>
                    {canReply
                      ? CALLBACK_REPLIES.map((r) => (
                          <Pressable
                            key={r}
                            accessibilityRole="button"
                            onPress={() => replyCallback(s.id, r)}
                            style={({ pressed }) => ({
                              minHeight: 52,
                              borderRadius: 14,
                              alignItems: 'center',
                              justifyContent: 'center',
                              paddingHorizontal: 12,
                              backgroundColor: r === 'now' ? t.brand : t.surface2,
                              opacity: pressed ? 0.8 : 1,
                            })}
                          >
                            <Text style={{ color: r === 'now' ? t.brandInk : t.text, fontSize: 17, fontWeight: r === 'now' ? '700' : '600' }}>{REPLY_LABELS[r]}</Text>
                          </Pressable>
                        ))
                      : null}
                    {canReply ? (
                      <WhatsAppCallButton
                        client={client}
                        memberId={s.from}
                        label={s.takenBy ? 'Call on WhatsApp' : 'Call on WhatsApp now'}
                        // Calling is saying so: nobody has taken it yet, so this also replies "I’m calling you now".
                        onDone={() => (s.takenBy ? setReactingTo(null) : replyCallback(s.id, 'now'))}
                      />
                    ) : null}
                    {canReply && !s.takenBy && client.feature('whatsapp') && client.phoneOf(s.from) ? (
                      <Text style={{ color: t.muted, fontSize: 14, textAlign: 'center' }}>Opens WhatsApp and tells {s.name} you’re calling now.</Text>
                    ) : null}
                    {canReply ? (
                      <Text style={{ color: t.muted, fontSize: 14, lineHeight: 18, textAlign: 'center' }}>
                        {s.name} hears your reply in Urdu. Morning and evening mean their time ({timeIn(s.tz)} now).
                      </Text>
                    ) : null}
                    <View style={{ height: 1, backgroundColor: t.line, marginVertical: 4 }} />
                  </View>
                );
              })()}
              {reactingTo.from === me && !reactingTo.peer ? <ReadBy receipts={client.receiptsFor(reactingTo)} showRead={readReceipts} /> : null}
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {QUICK_REACTIONS.map((e) => {
                  const mine = client.reactionsFor(reactingTo.id).some((r) => r.emoji === e && r.mine);
                  return (
                    <Pressable accessibilityRole="button"
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
      {canOpenPerson ? <PersonSheet client={client} memberId={personOpen ? peer : null} onClose={() => setPersonOpen(false)} /> : null}
    </View>
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

/** "Remembered: Dr. Lee", with Undo in it (and "Undone" once tapped). */
function KeptChip({
  kept,
  undoable,
  undone,
  onUndo,
  onLongPress,
  fs,
  style,
}: {
  kept: NonNullable<HelperReply['kept']>;
  undoable: boolean;
  undone: boolean;
  onUndo: () => void;
  onLongPress: () => void;
  fs: (n: number) => number;
  style?: object | null;
}) {
  const t = useTheme();
  const what = kept.titles.join(' · ');
  return (
    <Pressable accessibilityRole="button"
      onLongPress={onLongPress}
      delayLongPress={300}
      accessibilityLabel={`${kept.verb}: ${what}${undone ? '. Undone' : ''}`}
      accessibilityHint="Long-press to react"
      style={[{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingLeft: 12, paddingRight: undoable ? 4 : 12, paddingVertical: 4, borderRadius: 20, borderWidth: 1, borderColor: t.line, backgroundColor: t.surface }, style]}
    >
      <Text style={{ fontSize: fs(14) }}>📌</Text>
      <Text style={{ flexShrink: 1, color: undone ? t.muted : t.text, fontSize: fs(15), textDecorationLine: undone ? 'line-through' : 'none' }} numberOfLines={3}>
        <Text style={{ color: t.muted }}>{kept.verb}: </Text>
        <Text style={{ fontWeight: '600' }}>{what}</Text>
      </Text>
      {undoable ? (
        undone ? (
          <Text style={{ color: t.muted, fontSize: fs(14), paddingHorizontal: 8 }}>Undone</Text>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Undo. Forget ${what}`}
            hitSlop={6}
            onPress={onUndo}
            style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 12, borderRadius: 16, justifyContent: 'center', backgroundColor: pressed ? t.surface2 : t.brandSoft })}
          >
            <Text style={{ color: t.brand, fontSize: fs(14), fontWeight: '700' }}>Undo</Text>
          </Pressable>
        )
      ) : null}
    </Pressable>
  );
}

/** Undo at the foot of a helper's answer that changed its memory. */
function UndoLink({ undone, onPress, fs }: { undone: boolean; onPress: () => void; fs: (n: number) => number }) {
  const t = useTheme();
  if (undone) return <Text style={{ color: t.muted, fontSize: fs(14), marginTop: 4 }}>Undone</Text>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Undo" hitSlop={8} onPress={onPress} style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', marginTop: 2 }}>
      <Text style={{ color: t.brand, fontSize: fs(14), fontWeight: '700' }}>Undo</Text>
    </Pressable>
  );
}

/** Under a helper's reply: reminders it set up, and privacy notes as one short line each (tap for why). */
function ReplyNotes({ reply, fs }: { reply: HelperReply; fs: (n: number) => number }) {
  const t = useTheme();
  const [open, setOpen] = useState<number | null>(null);
  const line = { color: t.muted, fontSize: fs(14), lineHeight: fs(18) } as const;
  return (
    <View style={{ gap: 2, marginTop: 4, marginHorizontal: 6 }}>
      {reply.extra.map((x) => (
        <Text key={x} style={line}>
          {x}
        </Text>
      ))}
      {reply.notes.map((n, i) => (
        <Pressable
          key={n.short}
          accessibilityRole="button"
          accessibilityState={{ expanded: open === i }}
          accessibilityLabel={`${n.short}. ${open === i ? n.full : 'Tap for why'}`}
          onPress={() => setOpen(open === i ? null : i)}
          hitSlop={8}
          style={{ minHeight: 28, justifyContent: 'center' }}
        >
          <Text style={line}>
            🔒 {n.short}
            {open === i ? '' : '  ›'}
          </Text>
          {open === i ? <Text style={[line, { marginTop: 2 }]}>{n.full}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
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
