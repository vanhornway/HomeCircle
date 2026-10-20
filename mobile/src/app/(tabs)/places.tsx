import { Alert, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { CircleClient, Member, Place } from '@homecircle/core';
import { Avatar, Button, Card, H1, Icon, P, Screen } from '../../components/ui';
import { useAllCircles } from '../../lib/useCircle';
import { errorText } from '../../lib/circle';
import { formatFeet } from '../../lib/units';
import { useTheme } from '../../theme';

type Shared = { key: string; place: Place; copies: { client: CircleClient; place: Place }[] };

/** One entry per place, even when it was added to several circles. */
function sharedPlaces(clients: CircleClient[]): Shared[] {
  const byKey = new Map<string, Shared>();
  for (const client of clients) {
    for (const place of client.places.values()) {
      const key = place.group ? `g:${place.group}` : `${client.circleId}:${place.id}`;
      const entry = byKey.get(key) ?? { key, place, copies: [] };
      entry.copies.push({ client, place });
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].sort((a, b) => a.place.name.localeCompare(b.place.name));
}

export default function Places() {
  const t = useTheme();
  const clients = useAllCircles(['places', 'locations', 'members', 'circle']);
  const places = sharedPlaces(clients);
  const multi = clients.length > 1;

  const remove = (s: Shared) =>
    Alert.alert(
      `Delete ${s.place.name}?`,
      s.copies.length > 1
        ? `Arrival alerts for this place stop for everyone in ${s.copies.map((c) => c.client.circle.name).join(' and ')}.`
        : 'Arrival alerts for this place stop for everyone in the circle.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            Promise.all(s.copies.map((c) => c.client.deletePlace(c.place.id))).catch((e) => Alert.alert('Couldn’t delete', errorText(e))),
        },
      ],
    );

  return (
    <Screen>
      <H1 style={{ marginTop: 4 }}>Places</H1>
      <P muted style={{ marginTop: 6, marginBottom: 18 }}>
        When someone arrives at or leaves a place, their circle’s group chat gets a message. Each phone detects this itself; the server never learns where your places are.
      </P>
      <Button title="Add a place" variant="primary" onPress={() => router.push('/add-place')} />
      <View style={{ marginTop: 18, gap: 10 }}>
        {places.map((s) => {
          const here: Member[] = s.copies.flatMap(({ client, place }) =>
            client.memberList().filter((m) => client.locations.get(m.id)?.placeId === place.id),
          );
          const details = [`${formatFeet(s.place.radius)} radius`];
          if (multi) details.push(s.copies.map((c) => c.client.circle.name).join(', '));
          return (
            <Card key={s.key} style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="place" color={t.brand} size={26} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.text, fontWeight: '700', fontSize: 17 }}>{s.place.name}</Text>
                  {s.place.address ? (
                    <Text style={{ color: t.text, fontSize: 14 }} numberOfLines={2}>
                      {s.place.address}
                    </Text>
                  ) : null}
                  <Text style={{ color: t.muted, fontSize: 14 }}>{details.join(' · ')}</Text>
                </View>
                <Button small variant="danger" title="Delete" accessibilityLabel={`Delete ${s.place.name}`} onPress={() => remove(s)} />
              </View>
              {here.length ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 60 }}>
                  {here.slice(0, 4).map((m) => (
                    <Avatar key={m.id} name={m.name} color={m.color} size={28} />
                  ))}
                  <Text style={{ color: t.muted, fontSize: 14 }}>{[...new Set(here.map((m) => m.name))].join(', ')} here now</Text>
                </View>
              ) : null}
            </Card>
          );
        })}
        {!places.length ? <P muted>No places yet. Try Home, School or Work.</P> : null}
      </View>
    </Screen>
  );
}
