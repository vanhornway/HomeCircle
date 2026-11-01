import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ServerBanner } from '../../components/ServerBanner';
import { listsOf } from '../../lib/helperLists';
import { useCircle } from '../../lib/useCircle';
import { useTheme } from '../../theme';
import { MemoryBody } from '../agent-memory';
import { ShoppingBody } from '../lists';
import { RemindersBody } from '../reminders';

type Part = 'shopping' | 'reminders' | 'memory';

/** The circle's helper's shopping lists, reminders and memory, one tab with a switch at the top. */
export default function ListsTab() {
  const t = useTheme();
  const client = useCircle(['circle']);
  const has = listsOf(client);
  const parts = (
    [
      ['shopping', 'Shopping'],
      ['reminders', 'Reminders'],
      ['memory', 'Memory'],
    ] as const
  ).filter(([id]) => has[id]);
  const [picked, setPicked] = useState<Part>('shopping');
  // The circle on screen may not have the one that was open.
  const part = parts.some(([id]) => id === picked) ? picked : parts[0]?.[0];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top']}>
      <Text style={{ color: t.text, fontSize: 30, fontWeight: '800', paddingHorizontal: 20, paddingTop: 10, paddingBottom: 6 }}>Lists</Text>
      <ServerBanner style={{ marginHorizontal: 16, marginBottom: 6 }} />
      {parts.length ? (
        <>
          {parts.length > 1 ? (
            <View style={{ flexDirection: 'row', marginHorizontal: 16, marginBottom: 4, padding: 3, borderRadius: 12, backgroundColor: t.surface2 }}>
              {parts.map(([id, label]) => {
                const on = id === part;
                return (
                  <Pressable
                    key={id}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: on }}
                    onPress={() => setPicked(id)}
                    style={{ flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: on ? t.surface : 'transparent' }}
                  >
                    <Text style={{ color: on ? t.brand : t.muted, fontSize: 15, fontWeight: '700' }}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {part === 'shopping' ? <ShoppingBody /> : part === 'reminders' ? <RemindersBody /> : <MemoryBody />}
        </>
      ) : (
        <Text style={{ color: t.muted, fontSize: 15, lineHeight: 21, textAlign: 'center', margin: 24 }}>This circle has no helper with lists yet.</Text>
      )}
    </SafeAreaView>
  );
}
