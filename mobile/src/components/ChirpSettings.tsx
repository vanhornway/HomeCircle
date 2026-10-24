import { useState } from 'react';
import { Alert, Pressable, Switch, Text, View } from 'react-native';
import { CHIRP_SOUNDS, type ChirpSound, type CircleClient } from '@homecircle/core';
import { Card, Checkbox, SectionTitle } from './ui';
import { CHIRP_NAMES, previewChirp, setMyChirp } from '../lib/chirp';
import { errorText } from '../lib/circle';
import { updateSettings, type Settings } from '../lib/storage';
import { useTheme } from '../theme';

/** Your chirp (what others hear), and whether chirps sound or flash on this phone. */
export function ChirpSettings({ clients, settings, onChange }: { clients: CircleClient[]; settings: Settings | null; onChange: (s: Settings) => void }) {
  const t = useTheme();
  const [busy, setBusy] = useState<ChirpSound | null>(null);
  const mine = settings?.myChirp ?? clients.find((c) => c.me?.chirp)?.me?.chirp ?? null;

  const pick = async (sound: ChirpSound) => {
    previewChirp(sound);
    if (sound === mine) return;
    setBusy(sound);
    try {
      await setMyChirp(clients, sound);
      onChange({ ...(settings as Settings), myChirp: sound });
    } catch (e) {
      Alert.alert('Couldn’t save your chirp', errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <SectionTitle>Chirps</SectionTitle>
      <Card style={{ gap: 12 }}>
        <View>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>My chirp</Text>
          <Text style={{ color: t.muted, fontSize: 13, marginTop: 2 }}>
            What everyone hears when you chirp them, so they know it’s you without looking. Tap to listen.
          </Text>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {CHIRP_SOUNDS.map((sound) => {
            const on = sound === mine;
            return (
              <Pressable
                key={sound}
                accessibilityRole="radio"
                accessibilityState={{ selected: on, busy: busy === sound }}
                accessibilityLabel={`${CHIRP_NAMES[sound]} chirp`}
                onPress={() => pick(sound)}
                style={({ pressed }) => ({
                  minHeight: 44,
                  paddingHorizontal: 14,
                  borderRadius: 22,
                  borderWidth: 1,
                  borderColor: on ? t.brand : t.line,
                  backgroundColor: on ? t.brandSoft : pressed ? t.surface2 : 'transparent',
                  justifyContent: 'center',
                  opacity: busy && busy !== sound ? 0.6 : 1,
                })}
              >
                <Text style={{ color: on ? t.brand : t.text, fontWeight: on ? '700' : '500', fontSize: 15 }}>
                  {on ? '✓ ' : ''}
                  {CHIRP_NAMES[sound]}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {!mine ? <Text style={{ color: t.muted, fontSize: 13 }}>Until you pick one, others hear the Robin.</Text> : null}

        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Play chirps</Text>
            <Text style={{ color: t.muted, fontSize: 13, marginTop: 2 }}>
              {settings?.chirpSound ?? true ? 'You hear who’s chirping you. Silent while Do Not Disturb is on.' : 'Chirps show silently.'}
            </Text>
          </View>
          <Switch
            value={settings?.chirpSound ?? true}
            onValueChange={(v) => updateSettings({ chirpSound: v }).then(onChange)}
            trackColor={{ true: t.brand }}
          />
        </View>
        <Checkbox
          checked={settings?.chirpFlash ?? true}
          onChange={(v) => updateSettings({ chirpFlash: v }).then(onChange)}
          label="Flash the camera light"
          detail={
            settings?.chirpFlash ?? true
              ? 'When someone chirps with a flash, the light blinks three times. Never while Do Not Disturb is on.'
              : 'The light never blinks for chirps.'
          }
        />
        <Text style={{ color: t.muted, fontSize: 13 }}>
          Anyone can chirp the same person, or the whole circle, three times in a row, then has to wait 30 minutes.
        </Text>
      </Card>
    </>
  );
}
