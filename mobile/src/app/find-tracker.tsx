// Find it: an arrow and the distance from this phone to a tracker's last
// position, to walk to lost keys, a pet or a bag. The phone's compass turns
// the arrow; its GPS updates the distance. Chirp makes the tracker beep when
// you're close; Locate asks it for a fresh position.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import { distanceM } from '@homecircle/core';
import { Button, P } from '../components/ui';
import { GroupBody, SettingsPage } from '../components/SettingsKit';
import { chirpWithChoice } from '../lib/chirp';
import { locatePerson } from '../lib/people';
import { distanceText, trackerOf, trackerVia, useNow } from '../lib/trackers';
import { timeAgo, useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

/** Degrees clockwise from north, from a to b. */
function bearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

export default function FindTracker() {
  const t = useTheme();
  const { member } = useLocalSearchParams<{ member?: string }>();
  const client = useCircle(['locations', 'members', 'records']);
  const now = useNow(5_000);
  const [here, setHere] = useState<{ lat: number; lng: number; accuracy: number | null } | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let pos: Location.LocationSubscription | null = null;
    let head: Location.LocationSubscription | null = null;
    let alive = true;
    (async () => {
      const p = await Location.requestForegroundPermissionsAsync();
      if (!alive) return;
      if (!p.granted) return setProblem('HomeCircle needs your location to point the way.');
      pos = await Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 2 }, (l) =>
        setHere({ lat: l.coords.latitude, lng: l.coords.longitude, accuracy: l.coords.accuracy }),
      );
      head = await Location.watchHeadingAsync((h) => setHeading(h.trueHeading >= 0 ? h.trueHeading : h.magHeading)).catch(() => null);
    })();
    return () => {
      alive = false;
      pos?.remove();
      head?.remove();
    };
  }, []);

  const m = member ? client.members.get(member) : null;
  const tracker = member ? trackerOf(client, member) : null;
  const loc = member ? client.locations.get(member) : null;
  if (!m || !tracker) {
    return (
      <SettingsPage title="Find it">
        <GroupBody>
          <P muted>That tracker isn’t in this circle any more.</P>
        </GroupBody>
      </SettingsPage>
    );
  }

  const dist = here && loc ? distanceM(here, loc) : null;
  const dir = here && loc ? bearing(here, loc) : null;
  const turn = dir != null && heading != null ? (dir - heading + 360) % 360 : null;
  const close = dist != null && dist < 30 + (here?.accuracy ?? 0) + (loc?.accuracy ?? 0);
  return (
    <SettingsPage title={`Find ${m.name}`}>
      <GroupBody gap={16}>
        <View style={{ alignItems: 'center', paddingVertical: 12 }}>
          <View
            style={{ width: 220, height: 220, borderRadius: 110, borderWidth: 2, borderColor: t.line, alignItems: 'center', justifyContent: 'center', backgroundColor: t.surface }}
            accessible
            accessibilityLabel={dir != null ? `${m.name} is ${dist != null ? distanceText(dist) : ''} to the ${COMPASS[Math.round(dir / 45) % 8]}` : 'Waiting for positions'}
          >
            <Text style={{ fontSize: 120, color: close ? t.brand : t.text, transform: [{ rotate: `${turn ?? dir ?? 0}deg` }] }}>{close ? '●' : '↑'}</Text>
          </View>
          <Text style={{ color: t.text, fontSize: 34, fontWeight: '800', marginTop: 14 }}>{close ? 'Close by' : dist != null ? distanceText(dist) : '…'}</Text>
          <Text style={{ color: t.muted, fontSize: 16, marginTop: 4 }}>
            {dir != null ? (turn == null ? `to the ${COMPASS[Math.round(dir / 45) % 8]}` : close ? 'Chirp it and listen' : 'Walk where the arrow points') : problem ?? 'Finding where you are…'}
          </Text>
        </View>
        {loc ? (
          <P muted>
            Its position is from {timeAgo(loc.ts)} ({trackerVia(loc)}{loc.accuracy ? `, ±${Math.round(loc.accuracy)} m` : ''}).{' '}
            {now - loc.ts > 10 * 60_000 ? 'It may have moved since: tap Locate for a fresh one.' : ''}
          </P>
        ) : (
          <P muted>No position from it yet: tap Locate.</P>
        )}
        {heading == null && here ? <P muted>This phone has no compass reading: the direction is from north.</P> : null}
        <Button variant="primary" title="Chirp it" onPress={() => chirpWithChoice(client, m.id)} />
        <Button title="Locate (ask where it is)" onPress={() => locatePerson(client, m.id)} />
      </GroupBody>
    </SettingsPage>
  );
}
