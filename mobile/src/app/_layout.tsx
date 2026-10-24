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
          // Standard back navigation: swipe from the left edge on iOS, the
          // system back gesture or button on Android.
          gestureEnabled: true,
          animation: 'slide_from_right',
          contentStyle: { backgroundColor: t.bg },
          headerStyle: { backgroundColor: t.surface },
          headerTintColor: t.brand,
          headerTitleStyle: { color: t.text },
        }}
      >
        <Stack.Screen name="invite" options={{ headerShown: true, title: 'Invite someone' }} />
        <Stack.Screen name="add-place" options={{ headerShown: true, title: 'New place' }} />
        <Stack.Screen name="server" options={{ headerShown: true, title: 'Server address' }} />
        <Stack.Screen name="new-circle" options={{ headerShown: true, title: 'New circle' }} />
        <Stack.Screen name="setup" options={{ headerShown: true, title: '' }} />
        <Stack.Screen name="recover" options={{ headerShown: true, title: 'Use a setup code' }} />
        <Stack.Screen name="conversation" options={{ headerShown: false }} />
        <Stack.Screen name="setup-check" options={{ headerShown: true, title: 'Setup check' }} />
        <Stack.Screen name="diagnostics" options={{ headerShown: true, title: 'Diagnostics' }} />
        <Stack.Screen name="sos" options={{ headerShown: false, presentation: 'fullScreenModal', gestureEnabled: false }} />
        <Stack.Screen name="circle-health" options={{ headerShown: true, title: 'Circle health' }} />
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
