import { Pressable, Text, View } from 'react-native';
import { MADHABS } from '@homecircle/core';
import { updateSettings, useSettings } from '../lib/storage';
import { useTheme } from '../theme';

/** Under Prayer times in Features: each person picks their own madhab (kept on this phone). */
export function PrayerSetup() {
  const t = useTheme();
  const { prayerMadhab } = useSettings();
  return (
    <View style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 10 }}>
      <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>Your madhab</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {MADHABS.map((m) => {
          const on = m.id === prayerMadhab;
          return (
            <Pressable
              key={m.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => updateSettings({ prayerMadhab: m.id })}
              style={{
                paddingVertical: 8,
                paddingHorizontal: 14,
                borderRadius: 18,
                borderWidth: 1,
                borderColor: on ? t.brand : t.line,
                backgroundColor: on ? t.brandSoft : t.surface,
              }}
            >
              <Text style={{ color: on ? t.brand : t.text, fontSize: 14, fontWeight: on ? '700' : '500' }}>{m.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={{ color: t.muted, fontSize: 13, lineHeight: 18 }}>
        Hanafi Asr comes later, when a shadow is twice its length. Shia times follow the Ja‘fari method, with Maghrib once the redness in the east has gone. Fajr and Isha follow the region you or the person you select are in, so the times stay right as you travel. All
        times are approximate: allow a few minutes. Only your phone uses this choice.
      </Text>
    </View>
  );
}
