import { useRef, useState } from 'react';
import { FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { EMOJI_GROUPS, QUICK_REACTIONS, isEmojiOnly, type Message } from '@homecircle/core';
import { Icon } from '../../components/ui';
import { ServerBanner } from '../../components/ServerBanner';
import { useCircle } from '../../lib/useCircle';
import { errorText } from '../../lib/circle';
import { useTheme } from '../../theme';

const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export default function Chat() {
  const t = useTheme();
  const client = useCircle();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reactingTo, setReactingTo] = useState<Message | null>(null);
  const list = useRef<FlatList<Message>>(null);
  const me = client.account?.memberId;
  const messages = [...client.messages].reverse();

  const send = async () => {
    const value = text;
    if (!value.trim()) return;
    setText('');
    setError(null);
    try {
      await client.sendChat(value);
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

  const render = ({ item: m }: { item: Message }) => {
    const who = client.members.get(m.from);
    const name = who?.name || 'Former member';
    if (m.kind !== 'chat') {
      const label =
        m.kind === 'event'
          ? `${name} ${m.body?.action === 'left' ? 'left' : 'arrived at'} ${m.body?.placeName || 'a place'} · ${clock(m.ts)}`
          : '🔒 Sent before you joined';
      return (
        <Text style={{ alignSelf: 'center', color: t.muted, backgroundColor: t.surface2, fontSize: 13, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, overflow: 'hidden', marginVertical: 4 }}>
          {label}
        </Text>
      );
    }
    const mine = m.from === me;
    const big = isEmojiOnly(m.body?.text);
    const reactions = client.reactionsFor(m.id);
    return (
      <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', alignItems: mine ? 'flex-end' : 'flex-start', maxWidth: '82%', marginVertical: 3 }}>
        {!mine ? <Text style={{ color: who?.color || t.muted, fontSize: 12, fontWeight: '700', marginLeft: 4, marginBottom: 2 }}>{name}</Text> : null}
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
            paddingVertical: big ? 0 : 9,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          <Text style={big ? { fontSize: 44, lineHeight: 54 } : { color: mine ? t.brandInk : t.text, fontSize: 16, lineHeight: 21 }}>{m.body?.text}</Text>
        </Pressable>
        {reactions.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 3, justifyContent: mine ? 'flex-end' : 'flex-start' }}>
            {reactions.map((r) => (
              <Pressable
                key={r.emoji}
                onPress={() => react(m.id, r.emoji)}
                accessibilityLabel={`${r.emoji} from ${r.names.join(', ')}${r.mine ? '. Tap to remove yours' : '. Tap to add yours'}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 3,
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: r.mine ? t.brand : t.line,
                  backgroundColor: r.mine ? t.brandSoft : t.surface,
                }}
              >
                <Text style={{ fontSize: 14 }}>{r.emoji}</Text>
                {r.count > 1 ? <Text style={{ fontSize: 12, color: r.mine ? t.brand : t.muted, fontWeight: '600' }}>{r.count}</Text> : null}
              </Pressable>
            ))}
          </View>
        ) : null}
        <Text style={{ color: t.muted, fontSize: 11, marginTop: 2, marginHorizontal: 6 }}>{clock(m.ts)}</Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top']}>
      <View style={{ paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.line }}>
        <Text style={{ color: t.text, fontSize: 22, fontWeight: '700' }}>{client.circle.name}</Text>
        <Text style={{ color: t.muted, fontSize: 13 }}>End-to-end encrypted · {client.memberList().length} members</Text>
        <ServerBanner style={{ marginTop: 10 }} />
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
        <FlatList
          ref={list}
          inverted
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={render}
          contentContainerStyle={{ padding: 14 }}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<Text style={{ color: t.muted, textAlign: 'center', transform: [{ scaleY: -1 }] }}>No messages yet. Say hi 👋</Text>}
        />
        {error ? <Text style={{ color: t.danger, paddingHorizontal: 16 }}>{error}</Text> : null}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: t.line, backgroundColor: t.surface }}>
          <Pressable
            accessibilityLabel={pickerOpen ? 'Hide emoji' : 'Emoji'}
            onPress={() => {
              if (!pickerOpen) Keyboard.dismiss();
              setPickerOpen((v) => !v);
            }}
            style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: pickerOpen ? t.brandSoft : 'transparent' }}
          >
            <Text style={{ fontSize: 24 }}>😊</Text>
          </Pressable>
          <TextInput
            value={text}
            onChangeText={setText}
            onFocus={() => setPickerOpen(false)}
            placeholder="Message your circle"
            placeholderTextColor={t.muted}
            multiline
            maxLength={4000}
            style={{ flex: 1, minHeight: 42, maxHeight: 120, backgroundColor: t.bg, borderRadius: 21, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11, fontSize: 16, color: t.text }}
          />
          <Pressable
            accessibilityLabel="Send"
            onPress={send}
            disabled={!text.trim()}
            style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: t.brand, alignItems: 'center', justifyContent: 'center', opacity: text.trim() ? 1 : 0.5 }}
          >
            <Icon name="send" color={t.brandInk} size={20} />
          </Pressable>
        </View>
        {pickerOpen ? (
          <ScrollView style={{ maxHeight: 260, backgroundColor: t.surface }} contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 16 }} keyboardShouldPersistTaps="handled">
            {EMOJI_GROUPS.map((g) => (
              <View key={g.name}>
                <Text style={{ color: t.muted, fontSize: 12, fontWeight: '700', marginTop: 10, marginBottom: 4, marginLeft: 4 }}>{g.name}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                  {g.emojis.map((e) => (
                    <Pressable
                      key={e}
                      accessibilityLabel={`Insert ${e}`}
                      onPress={() => setText((v) => v + e)}
                      style={({ pressed }) => ({ width: '12.5%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: pressed ? t.surface2 : 'transparent' })}
                    >
                      <Text style={{ fontSize: 26 }}>{e}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ))}
          </ScrollView>
        ) : null}
      </KeyboardAvoidingView>

      <Modal visible={!!reactingTo} transparent animationType="fade" onRequestClose={() => setReactingTo(null)}>
        <Pressable onPress={() => setReactingTo(null)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          {reactingTo ? (
            <View style={{ backgroundColor: t.surface, borderRadius: 20, padding: 16, alignItems: 'center', gap: 12, maxWidth: 360 }}>
              <Text style={{ color: t.muted, fontSize: 14 }} numberOfLines={2}>
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
                      style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: mine ? t.brandSoft : t.surface2 }}
                    >
                      <Text style={{ fontSize: 26 }}>{e}</Text>
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
