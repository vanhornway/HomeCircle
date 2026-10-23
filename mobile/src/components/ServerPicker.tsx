import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { ServerGroup } from '../lib/circle';
import { Button } from './ui';
import { useTheme } from '../theme';

const circlesLabel = (n: number) => (n === 1 ? '1 circle' : `${n} circles`);

/**
 * The server whose circles are shown below it. Tapping it lists every server
 * this phone has circles on, plus a way to set up another one.
 */
export function ServerPicker({ groups, value, onChange }: { groups: ServerGroup[]; value: string; onChange: (url: string) => void }) {
  const t = useTheme();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const selected = groups.find((g) => g.url === value);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Server ${selected?.host || ''}. Choose a server`}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          minHeight: 48,
          paddingHorizontal: 12,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.line,
          backgroundColor: pressed ? t.surface2 : 'transparent',
          marginBottom: 6,
        })}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.muted, fontSize: 12, fontWeight: '700' }}>SERVER</Text>
          <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
            {selected?.host || 'Choose a server'}
          </Text>
        </View>
        <Text style={{ color: t.muted, fontSize: 13 }}>
          {groups.length > 1 ? `${groups.length} servers` : circlesLabel(selected?.circles.length ?? 0)}
        </Text>
        <Text style={{ color: t.muted, fontSize: 16 }}>▾</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable onPress={() => setOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', paddingHorizontal: 16 }}>
          <Pressable onPress={() => {}} style={{ backgroundColor: t.surface, borderRadius: 20, padding: 8 }}>
            <Text style={{ color: t.muted, fontSize: 12, fontWeight: '700', marginHorizontal: 12, marginTop: 8, marginBottom: 4 }}>YOUR SERVERS</Text>
            {groups.map((g) => {
              const on = g.url === value;
              return (
                <Pressable
                  key={g.url}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  onPress={() => {
                    setOpen(false);
                    onChange(g.url);
                  }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    padding: 12,
                    borderRadius: 14,
                    backgroundColor: on ? t.brandSoft : pressed ? t.surface2 : 'transparent',
                  })}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
                      {g.host || 'Unknown server'}
                    </Text>
                    <Text style={{ color: t.muted, fontSize: 13 }} numberOfLines={1}>
                      {circlesLabel(g.circles.length)}
                      {g.circles.some((c) => c.isServerAdmin) ? ' · you set it up' : ''}
                    </Text>
                  </View>
                  {on ? <Text style={{ color: t.brand, fontSize: 18, fontWeight: '700' }}>✓</Text> : null}
                </Pressable>
              );
            })}
            <View style={{ padding: 8, paddingTop: 12, gap: 8 }}>
              <Button
                small
                title="Set up a new server"
                onPress={() => {
                  setOpen(false);
                  router.push('/setup');
                }}
              />
              <Button
                small
                variant="ghost"
                title="Use this server’s setup code"
                onPress={() => {
                  setOpen(false);
                  router.push({ pathname: '/recover', params: { server: value } });
                }}
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
