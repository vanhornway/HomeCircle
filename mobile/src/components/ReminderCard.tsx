import { Text } from 'react-native';
import type { Message } from '@homecircle/core';
import { Button } from './ui';
import { HighlightCard } from './HighlightCard';
import { useChatFont } from '../lib/chatZoom';
import { parseReminder } from '../lib/reminderCard';
import { useTheme } from '../theme';

/**
 * A reminder from the circle's helper (car registration, passports…), in the
 * same highlighted card as a call-back request. Done is on the latest message
 * about it; an earlier one for the same reminder is shown quietly, as history.
 */
export function ReminderCard({ m, state, onDone, onLongPress }: { m: Message; state: 'open' | 'done' | 'earlier'; onDone: () => void; onLongPress: () => void }) {
  const t = useTheme();
  const fs = useChatFont();
  const r = parseReminder(String(m.body?.text ?? ''));
  const open = state === 'open';
  const detail = [r.when, r.note].filter(Boolean).join(' · ');
  return (
    <HighlightCard
      icon="bell"
      title={r.title}
      open={open}
      danger={r.late}
      onLongPress={onLongPress}
      label={`Reminder: ${r.title}. ${detail}${state === 'done' ? '. Marked done' : ''}`}
      hint="Long-press to react"
    >
      {r.when ? <Text style={{ color: open && r.late ? t.danger : t.muted, fontSize: fs(15), lineHeight: fs(20), fontWeight: open && r.late ? '700' : '400' }}>{r.when}</Text> : null}
      {r.note ? <Text style={{ color: t.text, fontSize: fs(14), lineHeight: fs(19) }}>{r.note}</Text> : null}
      {open ? (
        <Button title="Done" variant="primary" onPress={onDone} style={{ alignSelf: 'flex-start', minWidth: 140 }} />
      ) : (
        <Text style={{ color: state === 'done' ? t.ok : t.muted, fontSize: fs(14), fontWeight: '700' }}>{state === 'done' ? '✓ Marked done' : 'Earlier reminder'}</Text>
      )}
    </HighlightCard>
  );
}
