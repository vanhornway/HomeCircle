import { useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Message } from '@homecircle/core';
import { Icon } from '../../components/ui';
import { useCircle } from '../../lib/useCircle';
import { errorText } from '../../lib/circle';
import { useTheme } from '../../theme';

const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export default function Chat() {
  const t = useTheme();
  const client = useCircle();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
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
    return (
      <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', alignItems: mine ? 'flex-end' : 'flex-start', maxWidth: '82%', marginVertical: 3 }}>
        {!mine ? <Text style={{ color: who?.color || t.muted, fontSize: 12, fontWeight: '700', marginLeft: 4, marginBottom: 2 }}>{name}</Text> : null}
        <View style={{ backgroundColor: mine ? t.brand : t.surface, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9 }}>
          <Text style={{ color: mine ? t.brandInk : t.text, fontSize: 16, lineHeight: 21 }}>{m.body?.text}</Text>
        </View>
        <Text style={{ color: t.muted, fontSize: 11, marginTop: 2, marginHorizontal: 6 }}>{clock(m.ts)}</Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top']}>
      <View style={{ paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.line }}>
        <Text style={{ color: t.text, fontSize: 22, fontWeight: '700' }}>{client.circle.name}</Text>
        <Text style={{ color: t.muted, fontSize: 13 }}>End-to-end encrypted · {client.memberList().length} members</Text>
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
        <FlatList
          ref={list}
          inverted
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={render}
          contentContainerStyle={{ padding: 14 }}
          ListEmptyComponent={<Text style={{ color: t.muted, textAlign: 'center', transform: [{ scaleY: -1 }] }}>No messages yet. Say hi 👋</Text>}
        />
        {error ? <Text style={{ color: t.danger, paddingHorizontal: 16 }}>{error}</Text> : null}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: t.line, backgroundColor: t.surface }}>
          <TextInput
            value={text}
            onChangeText={setText}
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
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
