import { useState } from 'react';
import { Alert, Modal, Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { RejoinRequest } from '@homecircle/core';
import { errorText } from '../lib/circle';
import { useRejoinRequests } from '../lib/rejoin';
import { useCircle } from '../lib/useCircle';
import { Button } from './ui';
import { useTheme } from '../theme';

/**
 * Someone used the server's setup code to ask to rejoin this circle. Any
 * member can let them back in, after checking their safety number.
 */
export function RejoinBanner({ style }: { style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const client = useCircle(['circle']);
  const [requests, reload] = useRejoinRequests(client);
  const [open, setOpen] = useState<RejoinRequest | null>(null);
  const [busy, setBusy] = useState(false);
  if (!requests.length) return null;
  const first = requests[0];

  const decide = async (approve: boolean, q: RejoinRequest) => {
    setBusy(true);
    try {
      if (approve) await client.approveRejoin(q);
      else await client.denyRejoin(q.id);
      setOpen(null);
    } catch (e) {
      Alert.alert('Error', errorText(e));
    } finally {
      setBusy(false);
      reload();
    }
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen(first)}
        style={[{ backgroundColor: t.brandSoft, borderColor: t.brand, borderWidth: 1, borderRadius: 14, padding: 12, gap: 2 }, style]}
      >
        <Text style={{ color: t.text, fontWeight: '700', fontSize: 15 }}>
          {first.name} asked to rejoin {client.circle.name}
          {requests.length > 1 ? ` (+${requests.length - 1} more)` : ''}
        </Text>
        <Text style={{ color: t.muted, fontSize: 13 }}>With this server’s setup code. Tap to review.</Text>
      </Pressable>

      <Modal visible={!!open} transparent animationType="fade" onRequestClose={() => setOpen(null)}>
        <Pressable onPress={() => setOpen(null)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', paddingHorizontal: 16 }}>
          {open ? (
            <Pressable onPress={() => {}} style={{ backgroundColor: t.surface, borderRadius: 20, padding: 20, gap: 12 }}>
              <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>{open.name} wants to rejoin as the owner</Text>
              <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>
                They used this server’s setup code, which only the person who set up the server should have. Letting them in shows them everything in {client.circle.name}.
              </Text>
              <Text style={{ color: t.muted, fontSize: 14 }}>Ask them to read you their safety number. It must match:</Text>
              <Text style={{ color: t.text, fontSize: 18, fontFamily: 'monospace', letterSpacing: 1 }}>{open.safetyNumber}</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button small title="Deny" variant="danger" disabled={busy} onPress={() => decide(false, open)} style={{ flex: 1 }} />
                <Button
                  small
                  title="Let them in"
                  variant="primary"
                  loading={busy}
                  onPress={() =>
                    Alert.alert(`Let ${open.name} back in?`, `They’ll see everything in ${client.circle.name} and become its owner.`, [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Let them in', onPress: () => decide(true, open) },
                    ])
                  }
                  style={{ flex: 1 }}
                />
              </View>
              <Button small title="Not now" variant="ghost" onPress={() => setOpen(null)} />
            </Pressable>
          ) : null}
        </Pressable>
      </Modal>
    </>
  );
}
