import { Text, View } from 'react-native';
import type { CircleClient, Message } from '@homecircle/core';
import { HighlightCard } from './HighlightCard';
import { useChatFont } from '../lib/chatZoom';
import { WhatsAppCallButton } from './CallActions';
import { askedLine, REPLY_SHORT, timeIn } from '../lib/callbacks';
import { useTheme } from '../theme';

const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * A call-back request in the group chat: who asked and who was asked, then
 * where it stands. Long-press (or Reply) opens the replies.
 */
export function CallbackCard({ client, m, onReply }: { client: CircleClient; m: Message; onReply: () => void }) {
  const t = useTheme();
  const fs = useChatFont();
  const s = client.callbackState(m.id);
  if (!s) return null;
  const me = client.account?.memberId;
  const asksMe = client.callbackAsks(s);
  const mine = m.from === me;
  const answered = s.replies.find((r) => r.memberId === me);
  const others = s.replies.filter((r) => r.memberId !== s.takenBy?.memberId);
  // Everyone named as this viewer knows them: "Ammi wants a call back".
  const elder = client.displayName(s.from);
  const nameOf = (id: string) => (id === me ? 'You' : client.displayName(id));
  const title = mine ? 'You asked for a call back' : s.takenBy ? `${s.takenBy.memberId === me ? 'You are' : `${nameOf(s.takenBy.memberId)} is`} calling ${elder} now` : `${elder} wants a call back`;
  const detail = `${askedLine(client, s)} · ${mine ? 'your' : `${elder}’s`} time ${timeIn(s.tz, s.ts)} · ${s.awake ? 'awake' : 'in sleep hours'}`;
  const footer = s.takenBy
    ? `${clock(s.ts)} · ${nameOf(s.takenBy.memberId)} took it${s.remind ? ' · reminders stopped' : ''}`
    : `${clock(s.ts)}${s.remind ? ` · reminding every ${s.remind} min` : ''}`;
  return (
    <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', width: '84%', marginVertical: 4 }}>
      {!mine ? <Text style={{ color: client.members.get(m.from)?.color || t.muted, fontSize: fs(14), fontWeight: '700', marginLeft: 4, marginBottom: 2 }}>{elder}</Text> : null}
      <HighlightCard
        icon="phone"
        title={title}
        open={s.open}
        onLongPress={onReply}
        onPress={asksMe ? onReply : undefined}
        label={`${title}. ${detail}`}
        hint={asksMe ? 'Opens the replies' : undefined}
      >
        {s.takenBy && others.length ? (
          <Text style={{ color: t.muted, fontSize: fs(14), lineHeight: fs(19) }}>{others.map((r) => `${nameOf(r.memberId)}: ${REPLY_SHORT[r.reply]}`).join(' · ')}</Text>
        ) : (
          <Text style={{ color: t.muted, fontSize: fs(14), lineHeight: fs(19) }}>{detail}</Text>
        )}
        {s.takenBy?.memberId === me ? <WhatsAppCallButton client={client} memberId={s.from} /> : null}
        {s.open && !s.takenBy && s.replies.length ? (
          <Text style={{ color: t.text, fontSize: fs(14), lineHeight: fs(19) }}>{s.replies.map((r) => `${nameOf(r.memberId)}: ${REPLY_SHORT[r.reply]}`).join(' · ')}</Text>
        ) : null}
        {s.open && asksMe ? (
          <Text style={{ alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, overflow: 'hidden', backgroundColor: t.brandSoft, color: t.brand, fontSize: fs(14), fontWeight: '700' }}>
            {answered ? `You said ${REPLY_SHORT[answered.reply]} · tap to change` : 'Tap or long-press to reply'}
          </Text>
        ) : null}
      </HighlightCard>
      <Text style={{ color: t.muted, fontSize: fs(14), marginTop: 2, marginHorizontal: 6 }}>{footer}</Text>
    </View>
  );
}
