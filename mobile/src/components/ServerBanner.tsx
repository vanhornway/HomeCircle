import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button } from './ui';
import { retryServer, useServerState } from '../lib/connection';
import { getClient } from '../lib/circle';
import { useTheme } from '../theme';

/** Shown on every tab while the server can't be reached. */
export function ServerBanner({ style }: { style?: object }) {
  const t = useTheme();
  const server = useServerState();
  if (server.reachable) return null;
  const address = getClient().serverUrl?.replace(/^https?:\/\//, '') || 'your server';
  return (
    <View
      accessibilityRole="alert"
      style={[
        { backgroundColor: t.warnBg, borderRadius: 14, padding: 14, gap: 10, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 6, elevation: 2 },
        style,
      ]}
    >
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
