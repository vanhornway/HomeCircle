import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { CircleClient, PlanAnswer } from '@homecircle/core';
import { Button } from './ui';
import { HighlightCard } from './HighlightCard';
import { addPlanToCalendar } from '../lib/busy';
import { errorText } from '../lib/circle';
import { useChatFont } from '../lib/chatZoom';
import { useTheme } from '../theme';
import { showSheet } from '../lib/sheet';

const ANSWERS: { id: PlanAnswer; label: string }[] = [
  { id: 'going', label: 'Going' },
  { id: 'maybe', label: 'Maybe' },
  { id: 'no', label: 'Can’t' },
];

export function planWhen(p: { start: number; end: number; allDay: boolean }) {
  const day = new Date(p.start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (p.allDay) return day;
  const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${clock(p.start)} to ${clock(p.end)}`;
}

/** A plan in the chat: when and where, who's coming, your answer, and Add to my calendar. */
export function PlanCard({ client, planId }: { client: CircleClient; planId: string }) {
  const t = useTheme();
  const fs = useChatFont();
  const [now] = useState(() => Date.now());
  const s = client.planState(planId);
  if (!s) return null;
  const fail = (e: unknown) => showSheet('Plan', errorText(e));
  const mine = s.from === client.account?.memberId;
  const past = s.end < now;
  const open = !s.cancelled && !past;
  const who = (id: string) => (id === client.account?.memberId ? 'You' : client.displayName(id));
  const going = s.answers.filter((a) => a.answer === 'going').map((a) => who(a.memberId));
  const maybe = s.answers.filter((a) => a.answer === 'maybe').map((a) => who(a.memberId));
  const cant = s.answers.filter((a) => a.answer === 'no').map((a) => who(a.memberId));
  const cancel = () =>
    showSheet(`Cancel ${s.title}?`, 'Everyone sees that it’s off. It stays in calendars it was added to.', [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Cancel the plan', style: 'destructive', onPress: () => client.cancelPlan(planId).catch(fail) },
    ]);
  const line = { color: t.muted, fontSize: fs(14), lineHeight: fs(19) };
  return (
    <HighlightCard icon="calendar" title={s.cancelled ? `Cancelled: ${s.title}` : s.title} open={open} label={`${s.title}. ${planWhen(s)}`}>
      <Text style={{ color: t.text, fontSize: fs(15), lineHeight: fs(20) }}>{planWhen(s)}</Text>
      {s.where ? <Text style={line}>{s.where}</Text> : null}
      {going.length ? <Text style={line}>Going: {going.join(', ')}</Text> : null}
      {maybe.length ? <Text style={line}>Maybe: {maybe.join(', ')}</Text> : null}
      {cant.length ? <Text style={line}>Can’t: {cant.join(', ')}</Text> : null}
      {open ? (
        <>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {ANSWERS.map((a) => {
              const on = s.mine === a.id;
              return (
                <Pressable
                  key={a.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  onPress={() => client.answerPlan(planId, a.id).catch(fail)}
                  style={{ flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: on ? t.brand : t.line, backgroundColor: on ? t.brandSoft : t.surface }}
                >
                  <Text style={{ color: on ? t.brand : t.text, fontWeight: '600', fontSize: fs(15) }}>{a.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <Button small title="Add to my calendar" onPress={() => addPlanToCalendar(s).catch(fail)} />
          {mine ? <Button small variant="ghost" title="Cancel the plan" onPress={cancel} /> : null}
        </>
      ) : null}
    </HighlightCard>
  );
}
