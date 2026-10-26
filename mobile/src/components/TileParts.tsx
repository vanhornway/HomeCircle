import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '../theme';

/** What every face in the plugin tiles gets: who and where, the size, and the scale for its sizes. */
export type Face = { title: string; big: boolean; z: (n: number) => number };

/** A rounded pill on a face (high and low, rain, a pollen level). */
export function Pill({ z, bg, children }: { z: Face['z']; bg: string; children: ReactNode }) {
  return (
    <View
      style={{
        flex: 1,
        borderRadius: z(22),
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: bg,
      }}
    >
      {children}
    </View>
  );
}

/** The next 12 hours in two rows of six, so the tile needs no scrolling (and swipes stay swipes). */
export function HourGrid({
  hours,
}: {
  hours: {
    key: string;
    label: string;
    top: string | null;
    value: string;
    note?: string;
    dot?: string;
  }[];
}) {
  const t = useTheme();
  const rows = [hours.slice(0, 6), hours.slice(6, 12)].filter((r) => r.length);
  return (
    <View style={{ gap: 4 }}>
      {rows.map((row, i) => (
        <View key={i} style={{ flexDirection: 'row' }}>
          {row.map((h) => (
            <View key={h.key} style={{ flex: 1, alignItems: 'center' }}>
              <Text style={{ color: t.muted, fontSize: 10 }}>{h.label}</Text>
              {h.top ? (
                <Text style={{ fontSize: 14 }}>{h.top}</Text>
              ) : (
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    marginVertical: 3,
                    backgroundColor: h.dot ?? t.line,
                  }}
                />
              )}
              <Text style={{ color: t.text, fontSize: 12, fontWeight: '600' }}>{h.value}</Text>
              {h.note !== undefined ? <Text style={{ color: t.muted, fontSize: 9 }}>{h.note || ' '}</Text> : null}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}
