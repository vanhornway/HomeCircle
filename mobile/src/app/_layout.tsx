import { Stack } from 'expo-router';
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
      </Stack>
    </SafeAreaProvider>
  );
}
