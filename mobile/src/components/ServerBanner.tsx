import { Alert, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button } from './ui';
import { retryServer, setServerState, useServerState } from '../lib/connection';
import { getClient } from '../lib/circle';
import { useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

/**
 * Shown on every tab while the server can't be reached, or when it no longer
 * recognizes this phone in the open circle.
 */
export function ServerBanner({ style }: { style?: object }) {
  const t = useTheme();
  const server = useServerState();
  const client = useCircle(['status', 'circle']);
  const router = useRouter();
  const box = [
    { backgroundColor: t.warnBg, borderRadius: 14, padding: 14, gap: 10, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 6, elevation: 2 },
    style,
  ];

  if (server.unrecognized || client.status === 'unauthorized') {
    const name = client.circle.name;
    return (
      <View accessibilityRole="alert" style={box}>
        <View>
          <Text style={{ color: t.warnText, fontWeight: '700', fontSize: 15 }}>Your server doesn’t recognize this phone</Text>
          <Text style={{ color: t.warnText, fontSize: 13, marginTop: 2 }}>
            In {name}. You may have been removed, or the circle deleted. If the server lost its data, its keys on this phone are still here, so
            don’t remove it until you’re sure.
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button small title="Try again" onPress={retryServer} style={{ flex: 1 }} />
          <Button
            small
            title="Remove from phone"
            variant="danger"
            style={{ flex: 1 }}
            onPress={() =>
              Alert.alert(`Remove ${name} from this phone?`, 'Its keys on this phone are deleted. To come back, you’ll need a new invite.', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Remove',
                  style: 'destructive',
                  onPress: async () => {
                    await getClient().signOut();
                    setServerState({ unrecognized: false });
                    retryServer();
                  },
                },
              ])
            }
          />
        </View>
      </View>
    );
  }

  if (server.reachable) return null;
  const address = getClient().serverUrl?.replace(/^https?:\/\//, '') || 'your server';
  return (
    <View accessibilityRole="alert" style={box}>
      <View>
        <Text style={{ color: t.warnText, fontWeight: '700', fontSize: 15 }}>Can’t reach your server</Text>
        <Text style={{ color: t.warnText, fontSize: 13, marginTop: 2 }} numberOfLines={2}>
          {address}
          {server.retrying ? ' · retrying…' : ''}
        </Text>
        {server.error ? (
          <Text style={{ color: t.warnText, fontSize: 12, marginTop: 2, opacity: 0.8 }} numberOfLines={2}>
            {server.error}
          </Text>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button small title="Retry now" onPress={retryServer} style={{ flex: 1 }} />
        <Button small title="Change address" onPress={() => router.push('/server')} style={{ flex: 1 }} />
      </View>
    </View>
  );
}
