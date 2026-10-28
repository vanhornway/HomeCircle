import { Pressable, Text, View } from 'react-native';
import type { CircleClient, Message } from '@homecircle/core';
import { Icon } from './ui';
import { askedLine, REPLY_SHORT, timeIn } from '../lib/callbacks';
import { useTheme } from '../theme';

const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * A call-back request in the group chat: who asked and who was asked, then
 * where it stands. Long-press (or Reply) opens the replies.
 */
export function CallbackCard({ client, m, onReply }: { client: CircleClient; m: Message; onReply: () => void }) {
  const t = useTheme();
  const s = client.callbackState(m.id);
  if (!s) return null;
  const me = client.account?.memberId;
  const asksMe = client.callbackAsks(s);
  const mine = m.from === me;
  const answered = s.replies.find((r) => r.memberId === me);
  const others = s.replies.filter((r) => r.memberId !== s.takenBy?.memberId);
  const title = mine ? 'You asked for a call back' : s.takenBy ? `${s.takenBy.memberId === me ? 'You are' : `${s.takenBy.name} is`} calling ${s.name} now` : `${s.name} wants a call back`;
  const detail = `${askedLine(client, s)} · ${mine ? 'your' : `${s.name}’s`} time ${timeIn(s.tz, s.ts)} · ${s.awake ? 'awake' : 'in sleep hours'}`;
  const footer = s.takenBy
    ? `${clock(s.ts)} · ${s.takenBy.memberId === me ? 'You' : s.takenBy.name} took it${s.remind ? ' · reminders stopped' : ''}`
    : `${clock(s.ts)}${s.remind ? ` · reminding every ${s.remind} min` : ''}`;
  return (
    <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', width: '84%', marginVertical: 4 }}>
      {!mine ? <Text style={{ color: client.members.get(m.from)?.color || t.muted, fontSize: 13, fontWeight: '700', marginLeft: 4, marginBottom: 2 }}>{s.name}</Text> : null}
      <Pressable
        onLongPress={onReply}
        onPress={asksMe ? onReply : undefined}
        delayLongPress={300}
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${detail}`}
        accessibilityHint={asksMe ? 'Opens the replies' : undefined}
        style={({ pressed }) => ({ gap: 10, padding: 14, borderRadius: 18, backgroundColor: t.surface, borderWidth: 2, borderColor: s.open ? t.brand : t.line, opacity: pressed ? 0.8 : 1 })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: s.open ? t.brand : t.surface2, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="phone" color={s.open ? t.brandInk : t.brand} size={22} />
          </View>
          <Text style={{ flex: 1, color: t.text, fontSize: 18, fontWeight: '700', lineHeight: 22 }}>{title}</Text>
        </View>
        {s.takenBy && others.length ? (
          <Text style={{ color: t.muted, fontSize: 14, lineHeight: 19 }}>{others.map((r) => `${r.memberId === me ? 'You' : r.name}: ${REPLY_SHORT[r.reply]}`).join(' · ')}</Text>
        ) : (
          <Text style={{ color: t.muted, fontSize: 14, lineHeight: 19 }}>{detail}</Text>
        )}
        {s.open && !s.takenBy && s.replies.length ? (
          <Text style={{ color: t.text, fontSize: 14, lineHeight: 19 }}>{s.replies.map((r) => `${r.memberId === me ? 'You' : r.name}: ${REPLY_SHORT[r.reply]}`).join(' · ')}</Text>
        ) : null}
        {s.open && asksMe ? (
          <Text style={{ alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, overflow: 'hidden', backgroundColor: t.brandSoft, color: t.brand, fontSize: 13, fontWeight: '700' }}>
            {answered ? `You said ${REPLY_SHORT[answered.reply]} · tap to change` : 'Tap or long-press to reply'}
          </Text>
        ) : null}
      </Pressable>
      <Text style={{ color: t.muted, fontSize: 12, marginTop: 2, marginHorizontal: 6 }}>{footer}</Text>
    </View>
  );
}
