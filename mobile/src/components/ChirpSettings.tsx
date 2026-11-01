import { useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { CHIRP_SOUNDS, type ChirpSound, type CircleClient } from '@homecircle/core';
import { Button, Card, Checkbox, SectionTitle } from './ui';
import { HowThisWorks } from './HowThisWorks';
import * as IntentLauncher from 'expo-intent-launcher';
import { hasDndAccess } from '../../modules/hc-attention/src/HcAttentionModule';
import { CHIRP_NAMES, previewChirp, setMyChirp } from '../lib/chirp';
import { errorText } from '../lib/circle';
import { updateSettings, type Settings } from '../lib/storage';
import { useTheme } from '../theme';
import { showSheet } from '../lib/sheet';

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
      showSheet('Couldn’t save your chirp', errorText(e));
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
          <Text style={{ color: t.muted, fontSize: 14, marginTop: 2 }}>
            What others hear when you chirp them. Tap to listen.
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
        {!mine ? <Text style={{ color: t.muted, fontSize: 14 }}>Until you pick one, others hear the Robin.</Text> : null}

        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Play chirps</Text>
            <Text style={{ color: t.muted, fontSize: 14, marginTop: 2 }}>
              {settings?.chirpSound ?? true ? 'You hear who’s chirping you.' : 'Chirps show silently.'}
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
              ? 'The light blinks three times for a chirp with a flash.'
              : 'The light never blinks for chirps.'
          }
        />
        <HowThisWorks title="How chirps work">
          {[
            'Chirps are silent while Do Not Disturb is on, and the light never blinks then.',
            'Anyone can chirp the same person, or the whole circle, three times in a row, then has to wait 30 minutes.',
            'At school from 8 AM to 3 PM, chirps only flash, so they don’t go off in class. A school is a place with “school” in its name, or a school among your most visited places.',
          ]}
        </HowThisWorks>
      </Card>

      <SectionTitle>SOS</SectionTitle>
      <Card style={{ gap: 12 }}>
        <Text style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>
          Hold the red SOS button on the map for 2 seconds to alert everyone in your circles.
        </Text>
        <HowThisWorks title="What SOS does">
          After a 5-second countdown, everyone in your circles is alerted and your exact location is shared every minute until you say you’re safe.
        </HowThisWorks>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Ring through Do Not Disturb</Text>
            <Text style={{ color: t.muted, fontSize: 14, marginTop: 2 }}>
              {settings?.sosThroughDnd
                ? 'An SOS from your circle plays at alarm volume.'
                : 'Off. Do Not Disturb silences SOS alerts.'}
            </Text>
          </View>
          <Switch
            value={settings?.sosThroughDnd ?? false}
            onValueChange={(v) => updateSettings({ sosThroughDnd: v }).then(onChange)}
            trackColor={{ true: t.danger }}
          />
        </View>
        <DndAccess />
      </Card>
    </>
  );
}

/**
 * Let HomeCircle through Do Not Disturb in the phone's settings: then an
 * SOS notification rings through it itself, not only at alarm volume. An
 * SOS from an elder on the elder screens always tries to get
 * through.
 */
function DndAccess() {
  const t = useTheme();
  const [granted, setGranted] = useState(hasDndAccess);
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Do Not Disturb access</Text>
      <Text style={{ color: t.muted, fontSize: 14 }}>
        {granted
          ? 'Allowed. An SOS notification rings even with Do Not Disturb or bedtime on.'
          : 'Lets an SOS notification through Do Not Disturb, even if alarms are silenced.'}
      </Text>
      {granted ? null : (
        <Button
          small
          title="Allow in settings"
          onPress={() =>
            IntentLauncher.startActivityAsync('android.settings.NOTIFICATION_POLICY_ACCESS_SETTINGS')
              .then(() => setGranted(hasDndAccess()))
              .catch(() => {})
          }
        />
      )}
    </View>
  );
}
