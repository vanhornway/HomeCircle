import { Text, View } from 'react-native';
import type { CircleClient, Message } from '@homecircle/core';
import { HighlightCard } from './HighlightCard';
import { Button } from './ui';
import { useChatFont } from '../lib/chatZoom';
import { joinGroupCall } from '../lib/groupCalls';
import { useTheme } from '../theme';

const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * "Maya started the group call" in the group chat: who's on it, and Join,
 * which opens WhatsApp in the call. After 30 minutes without anyone joining
 * it's over, and shrinks to one quiet line: "Group call · 9:57 PM · Maya, you".
 */
export function GroupCallCard({ client, m }: { client: CircleClient; m: Message }) {
  const t = useTheme();
  const fs = useChatFont();
  const s = client.groupCallState(m.id);
  if (!s) return null;
  const me = client.account?.memberId;
  const mine = m.from === me;
  const nameOf = (id: string) => (id === me ? 'You' : client.displayName(id));
  if (!s.open) {
    const names = s.joined.map((id) => (id === me ? 'you' : client.displayName(id))).join(', ');
    const line = `Group call · ${clock(s.ts)} · ${names.charAt(0).toUpperCase()}${names.slice(1)}`;
    return (
      <Text
        style={{ alignSelf: 'center', color: t.muted, backgroundColor: t.surface2, fontSize: fs(14), paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, overflow: 'hidden', marginVertical: 4 }}
      >
        {line}
      </Text>
    );
  }
  const inIt = s.joined.includes(me ?? '');
  const title = `${mine ? 'You' : client.displayName(s.from)} started the group call`;
  const who = s.joined.map(nameOf).join(', ');
  const detail = `On it: ${who}`;
  const join = () => void joinGroupCall(client, s.id);
  return (
    <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', width: '84%', marginVertical: 4 }}>
      <HighlightCard icon="phone" title={title} open onPress={join} label={`${title}. ${detail}`} hint="Opens WhatsApp in the call">
        <Text style={{ color: t.muted, fontSize: fs(14), lineHeight: fs(19) }}>{detail}</Text>
        <Button small variant="primary" title={inIt ? 'Back to the call' : 'Join in WhatsApp'} onPress={join} />
      </HighlightCard>
      <Text style={{ color: t.muted, fontSize: fs(14), marginTop: 2, marginHorizontal: 6 }}>{clock(s.ts)}</Text>
    </View>
  );
}
