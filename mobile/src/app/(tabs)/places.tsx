import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { CircleClient, Member, Place } from '@homecircle/core';
import { Avatar, Button, Card, Checkbox, H1, Icon, P, Screen, SectionTitle } from '../../components/ui';
import { AlertRuleSheet } from '../../components/AlertRuleSheet';
import { updateSettings, useSettings } from '../../lib/storage';
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
  // Arrived and left alerts only in circles that have them.
  const alerts = clients.some((c) => c.feature('placeAlerts'));
  const settings = useSettings();
  const [adding, setAdding] = useState(false);
  const ruleText = (r: (typeof settings.alertRules)[number]) => {
    const c = clients.find((x) => x.circleId === r.circleId);
    const who = c?.members.get(r.memberId)?.name ?? 'Someone';
    const where = c?.places.get(r.placeId)?.name ?? 'a place';
    const when = r.on === 'arrived' ? 'arrives at' : r.on === 'left' ? 'leaves' : 'arrives at or leaves';
    return `${who} ${when} ${where}${multi && c ? ` · ${c.circle.name}` : ''}`;
  };
  const removeRule = (id: string) => updateSettings({ alertRules: settings.alertRules.filter((r) => r.id !== id) });

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

  // Name, spot and radius, for every circle that has the place.
  const edit = (s: Shared) => router.push({ pathname: '/add-place', params: { circle: s.copies[0].client.circleId!, id: s.copies[0].place.id } });

  return (
    <Screen>
      <H1 style={{ marginTop: 4 }}>Places</H1>
      <P muted style={{ marginTop: 6, marginBottom: 18 }}>
        {alerts
          ? 'When someone arrives at or leaves a place, their circle’s group chat gets a message. Each phone detects this itself; the server never learns where your places are.'
          : 'Places your circle shares on the map. The server never learns where they are.'}
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
            <Pressable
              key={s.key}
              onLongPress={() => edit(s)}
              accessibilityHint="Long-press to change its name, spot or radius"
              style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
            >
            <Card style={{ gap: 6 }}>
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
                <View style={{ gap: 6 }}>
                  <Button small title="Edit" accessibilityLabel={`Edit ${s.place.name}`} onPress={() => edit(s)} />
                  <Button small variant="danger" title="Delete" accessibilityLabel={`Delete ${s.place.name}`} onPress={() => remove(s)} />
                </View>
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
            </Pressable>
          );
        })}
        {!places.length ? <P muted>No places yet. Try Home, School or Work.</P> : null}
      </View>

      {alerts ? (
        <>
          <SectionTitle>My alerts</SectionTitle>
          <Card style={{ gap: 6 }}>
            {settings.alertRules.map((r) => (
              <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48 }}>
                <Icon name="bell" color={t.brand} size={22} />
                <Text style={{ flex: 1, color: t.text, fontSize: 16 }}>Notify me when {ruleText(r)}</Text>
                <Button small title="Remove" onPress={() => removeRule(r.id)} />
              </View>
            ))}
            {!settings.alertRules.length ? (
              <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>Get a notification when someone arrives at or leaves a place, like “Dad leaves Work”.</Text>
            ) : null}
            <Button title="Add an alert" onPress={() => setAdding(true)} style={{ marginTop: 6 }} />
            <Checkbox
              checked={settings.notifyAllPlaceAlerts}
              onChange={(v) => updateSettings({ notifyAllPlaceAlerts: v })}
              label="Also notify me about everyone else"
              detail={
                settings.notifyAllPlaceAlerts
                  ? 'Every arrival and departure in your circles notifies you.'
                  : 'Only the alerts above notify you. Others still show in the group chat.'
              }
            />
          </Card>
        </>
      ) : null}
      {adding ? <AlertRuleSheet clients={clients} visible onClose={() => setAdding(false)} /> : null}
    </Screen>
  );
}
