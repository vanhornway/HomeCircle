import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { Text, View } from 'react-native';
import { Button, Logo } from '../components/ui';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import '../lib/push';

export default function RootLayout() {
  const t = useTheme();
  return (
    <SafeAreaProvider>
      <StatusBar style={t.dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: t.bg },
          headerStyle: { backgroundColor: t.surface },
          headerTintColor: t.brand,
          headerTitleStyle: { color: t.text },
        }}
      >
        <Stack.Screen name="invite" options={{ presentation: 'modal', headerShown: true, title: 'Invite someone' }} />
        <Stack.Screen name="add-place" options={{ presentation: 'modal', headerShown: true, title: 'New place' }} />
        <Stack.Screen name="server" options={{ presentation: 'modal', headerShown: true, title: 'Server address' }} />
        <Stack.Screen name="new-circle" options={{ presentation: 'modal', headerShown: true, title: 'New circle' }} />
      </Stack>
    </SafeAreaProvider>
  );
}

/** Any unexpected error shows this screen instead of closing the app. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.bg, padding: 24, justifyContent: 'center', gap: 14 }}>
      <Logo size={56} />
      <Text style={{ color: t.text, fontSize: 24, fontWeight: '700' }}>Something went wrong</Text>
      <Text style={{ color: t.muted, fontSize: 15, lineHeight: 21 }}>
        HomeCircle hit an unexpected problem. Your keys and settings are safe on this phone.
      </Text>
      <Text style={{ color: t.muted, fontSize: 13 }} selectable>
        {error.message}
      </Text>
      <Button title="Try again" variant="primary" onPress={retry} />
    </View>
  );
}
