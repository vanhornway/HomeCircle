import { useState } from 'react';
import { Modal, Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { setActiveCircle, useCircles } from '../lib/circle';
import { unreadInCircle } from '../lib/unread';
import { useAllCircles, useCircle } from '../lib/useCircle';
import { Button, Icon } from './ui';
import { useTheme } from '../theme';

/**
 * The active circle's name. Tapping it lists every circle on this phone to
 * switch between, plus ways to create or join another.
 */
export function CircleSwitcher({ style, large }: { style?: StyleProp<ViewStyle>; large?: boolean }) {
  const t = useTheme();
  const client = useCircle(['circle', 'status']);
  const { clients } = useCircles();
  useAllCircles(['messages', 'circle']);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const otherUnread = clients.some((c) => c !== client && unreadInCircle(c) > 0);
  const canCreate = clients.some((c) => c.isServerAdmin);

  const go = (path: '/new-circle' | '/join') => {
    setOpen(false);
    router.push(path);
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${client.circle.name}. Switch circle`}
        hitSlop={8}
        style={[{ flexDirection: 'row', alignItems: 'center', gap: 6 }, style]}
      >
        {large ? null : (
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: client.status === 'online' ? t.ok : client.status === 'connecting' ? t.accent : t.muted,
            }}
          />
        )}
        <Text style={{ color: t.text, fontWeight: '700', fontSize: large ? 22 : 15 }} numberOfLines={1}>
          {client.circle.name}
        </Text>
        <Text style={{ color: t.muted, fontSize: large ? 16 : 12 }}>▾</Text>
        {otherUnread ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.danger }} /> : null}
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable onPress={() => setOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-start', paddingTop: 90, paddingHorizontal: 16 }}>
          <Pressable onPress={() => {}} style={{ backgroundColor: t.surface, borderRadius: 20, padding: 8 }}>
            <Text style={{ color: t.muted, fontSize: 12, fontWeight: '700', marginHorizontal: 12, marginTop: 8, marginBottom: 4 }}>YOUR CIRCLES</Text>
            {clients.map((c) => {
              const isActive = c === client;
              const n = unreadInCircle(c);
              return (
                <Pressable
                  key={c.accountKey}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isActive }}
                  onPress={() => {
                    setOpen(false);
                    setActiveCircle(c.accountKey).catch(() => {});
                  }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    padding: 12,
                    borderRadius: 14,
                    backgroundColor: isActive ? t.brandSoft : pressed ? t.surface2 : 'transparent',
                  })}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
                      {c.circle.name}
                    </Text>
                    <Text style={{ color: t.muted, fontSize: 13 }} numberOfLines={1}>
                      {c.memberList().length || ''}
                      {c.memberList().length ? (c.memberList().length === 1 ? ' member · ' : ' members · ') : ''}
                      {c.serverUrl?.replace(/^https?:\/\//, '')}
                    </Text>
                  </View>
                  {n ? (
                    <View style={{ minWidth: 22, height: 22, borderRadius: 11, backgroundColor: t.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 }}>
                      <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>{n > 9 ? '9+' : n}</Text>
                    </View>
                  ) : null}
                  {isActive ? <Text style={{ color: t.brand, fontSize: 18, fontWeight: '700' }}>✓</Text> : null}
                </Pressable>
              );
            })}
            <View style={{ flexDirection: 'row', gap: 8, padding: 8, paddingTop: 12 }}>
              {canCreate ? <Button small title="New circle" onPress={() => go('/new-circle')} style={{ flex: 1 }} /> : null}
              <Button small title="Join a circle" onPress={() => go('/join')} style={{ flex: 1 }} />
            </View>
            {canCreate ? null : (
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingHorizontal: 12, paddingBottom: 10 }}>
                <Icon name="lock" size={14} color={t.muted} />
                <Text style={{ color: t.muted, fontSize: 12, flex: 1 }}>Only the person who set up your server can create new circles on it.</Text>
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
