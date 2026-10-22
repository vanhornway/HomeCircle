import { useCallback, useEffect, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Button, Card, P, Screen } from '../components/ui';
import { makerTips, needsAttention, setupChecklist, type CheckItem } from '../lib/health';
import { shareNow, startBackgroundUpdates } from '../lib/location';
import { useTheme } from '../theme';

/**
 * Everything this phone needs to share its location reliably, with a green
 * check per item and a one-tap fix. Re-checked whenever you come back from
 * the system settings.
 */
export default function SetupCheck() {
  const t = useTheme();
  const [items, setItems] = useState<CheckItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setupChecklist().then(setItems).catch(() => setItems([]));
  }, []);
  useFocusEffect(refresh);
  useEffect(() => {
    // Coming back from the system settings.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        refresh();
        startBackgroundUpdates().catch(() => {});
      }
    });
    return () => sub.remove();
  }, [refresh]);

  const fix = async (item: CheckItem) => {
    setBusy(item.id);
    try {
      await item.fix();
    } finally {
      setBusy(null);
      refresh();
      startBackgroundUpdates().catch(() => {});
    }
  };

  const issues = items ? needsAttention(items) : [];
  const tips = makerTips();

  return (
    <Screen>
      <P muted style={{ marginTop: 8, marginBottom: 14 }}>
        Each item helps your circle see where you are, even when your phone is locked or in your pocket.
      </P>
      {items && !issues.length ? (
        <Card style={{ backgroundColor: t.brandSoft, borderColor: t.brand, marginBottom: 12 }}>
          <Text style={{ color: t.brand, fontWeight: '700', fontSize: 16 }}>✓ All set</Text>
          <Text style={{ color: t.text, fontSize: 14, marginTop: 4 }}>This phone is set up to share reliably.</Text>
        </Card>
      ) : null}
      <View style={{ gap: 10 }}>
        {(items ?? []).map((item) => (
          <Card key={item.id} style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
            <View
              style={{
                width: 30,
                height: 30,
                borderRadius: 15,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: item.ok ? t.brand : item.unknown ? t.surface2 : t.warnBg,
                marginTop: 2,
              }}
            >
              <Text style={{ color: item.ok ? t.brandInk : item.unknown ? t.muted : t.warnText, fontWeight: '800' }}>{item.ok ? '✓' : item.unknown ? '?' : '!'}</Text>
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{item.title}</Text>
              <Text style={{ color: t.muted, fontSize: 14, lineHeight: 19 }}>
                {item.unknown && !item.ok ? 'Your phone doesn’t report this. Check it in Settings. ' : ''}
                {item.why}
              </Text>
              {!item.ok || item.unknown ? (
                <Button small title={item.fixLabel} loading={busy === item.id} onPress={() => fix(item)} style={{ alignSelf: 'flex-start', marginTop: 4 }} />
              ) : null}
            </View>
          </Card>
        ))}
      </View>
      {tips ? (
        <Card style={{ marginTop: 14 }}>
          <Text style={{ color: t.text, fontWeight: '700', fontSize: 16 }}>Extra step for {tips.maker} phones</Text>
          <Text style={{ color: t.muted, fontSize: 14, marginTop: 4, lineHeight: 20 }}>{tips.steps}</Text>
        </Card>
      ) : null}
      <Button
        title="Share my location now"
        style={{ marginTop: 16 }}
        onPress={() => shareNow('manual').then(() => router.back())}
      />
    </Screen>
  );
}
