import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { isoDate, monthWeeks, prettyDate } from '../lib/dueDate';
import { useTheme } from '../theme';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** A few dates people usually mean, as one-tap chips. */
function soon(today: Date): { label: string; date: string }[] {
  const at = (months: number) => isoDate(new Date(today.getFullYear(), today.getMonth() + months, today.getDate()));
  return [
    { label: 'In a week', date: isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7)) },
    { label: 'In a month', date: at(1) },
    { label: 'In 3 months', date: at(3) },
    { label: 'In a year', date: at(12) },
  ];
}

/**
 * A date field that opens a month calendar right below it (no second sheet
 * on top of the one it's in). `value` and `onChange` use YYYY-MM-DD.
 */
export function DatePicker({ value, onChange, label = 'When it’s due' }: { value: string | null; onChange: (date: string) => void; label?: string }) {
  const t = useTheme();
  const today = new Date();
  const todayIso = isoDate(today);
  const [open, setOpen] = useState(!value);
  const start = value ?? todayIso;
  const [shown, setShown] = useState({ year: Number(start.slice(0, 4)), month: Number(start.slice(5, 7)) });
  const step = (by: number) =>
    setShown(({ year, month }) => {
      const m = month - 1 + by;
      return { year: year + Math.floor(m / 12), month: (((m % 12) + 12) % 12) + 1 };
    });
  const pick = (date: string) => {
    onChange(date);
    setShown({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) });
    setOpen(false);
  };
  const chip = (on: boolean) => ({ minHeight: 44, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: on ? t.brand : t.line, backgroundColor: on ? t.brandSoft : t.surface, justifyContent: 'center' as const });

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value ? prettyDate(value) : 'not picked yet'}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => ({ minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: t.line, backgroundColor: pressed ? t.surface2 : t.surface, paddingHorizontal: 14, justifyContent: 'center' })}
      >
        <Text style={{ color: value ? t.text : t.muted, fontSize: 16 }}>{value ? prettyDate(value) : 'Pick a date'}</Text>
      </Pressable>
      {open ? (
        <View style={{ gap: 10, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: t.line, backgroundColor: t.surface }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {soon(today).map((s) => (
              <Pressable key={s.label} accessibilityRole="button" accessibilityLabel={`${s.label}, ${prettyDate(s.date)}`} onPress={() => pick(s.date)} style={chip(value === s.date)}>
                <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{s.label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Pressable accessibilityRole="button" accessibilityLabel="Previous month" onPress={() => step(-1)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: t.brand, fontSize: 24 }}>‹</Text>
            </Pressable>
            <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 16, fontWeight: '700' }}>
              {MONTH_NAMES[shown.month - 1]} {shown.year}
            </Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Next month" onPress={() => step(1)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: t.brand, fontSize: 24 }}>›</Text>
            </Pressable>
          </View>
          <View style={{ flexDirection: 'row' }}>
            {WEEKDAYS.map((d, i) => (
              <Text key={i} importantForAccessibility="no" style={{ flex: 1, textAlign: 'center', color: t.muted, fontSize: 14, fontWeight: '600' }}>
                {d}
              </Text>
            ))}
          </View>
          {monthWeeks(shown.year, shown.month).map((week, w) => (
            <View key={w} style={{ flexDirection: 'row' }}>
              {week.map((day, i) => {
                if (!day) return <View key={i} style={{ flex: 1, height: 44 }} />;
                const on = day === value;
                const isToday = day === todayIso;
                return (
                  <Pressable key={day} accessibilityRole="button" accessibilityLabel={prettyDate(day)} accessibilityState={{ selected: on }} onPress={() => pick(day)} style={{ flex: 1, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                    <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.brand : 'transparent', borderWidth: isToday && !on ? 1 : 0, borderColor: t.brand }}>
                      <Text style={{ color: on ? t.brandInk : t.text, fontSize: 16, fontWeight: on || isToday ? '700' : '400' }}>{Number(day.slice(8))}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
