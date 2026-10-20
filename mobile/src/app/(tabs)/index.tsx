import { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { MemberLocation, Place } from '@homecircle/core';
import { FamilyMap, type MapMember } from '../../map/FamilyMap';
import { Avatar, Button, Tag } from '../../components/ui';
import { ServerBanner } from '../../components/ServerBanner';
import { CircleSwitcher } from '../../components/CircleSwitcher';
import { useServerState } from '../../lib/connection';
import { initials, timeAgo, useCircle } from '../../lib/useCircle';
import { distanceM } from '../../lib/location';
import { errorText } from '../../lib/circle';
import { DEFAULT_SETTINGS, getSettings } from '../../lib/storage';
import { useTheme } from '../../theme';

const STALE_MS = 2 * 3600_000;

function placeAt(loc: MemberLocation | undefined, places: Map<string, Place>) {
  if (!loc) return null;
  if (loc.placeId && places.has(loc.placeId)) return places.get(loc.placeId)!;
  for (const p of places.values()) if (distanceM(loc, p) <= p.radius) return p;
  return null;
}

export default function MapTab() {
  const t = useTheme();
  const client = useCircle();
  const server = useServerState();
  const [tiles, setTiles] = useState(DEFAULT_SETTINGS);
  const [focus, setFocus] = useState<{ lat: number; lng: number; key: number } | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  // Clock for "5 min ago" labels and the Locate cooldown.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    getSettings().then(setTiles);
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const members = client.memberList();
  // Circle data is mutated in place, so memoize on content rather than identity.
  const mapMembersRaw: MapMember[] = members.flatMap((m) => {
    const loc = client.locations.get(m.id);
    if (!loc) return [];
    return [
      {
        id: m.id,
        label: initials(m.name),
        title: m.name,
        color: m.color,
        lat: loc.lat,
        lng: loc.lng,
        accuracy: loc.accuracy || 0,
        stale: now - loc.ts > STALE_MS,
      },
    ];
  });
  const membersKey = JSON.stringify(mapMembersRaw);
  const mapMembers = useMemo(() => JSON.parse(membersKey) as MapMember[], [membersKey]);
  const placesRaw = [...client.places.values()];
  const placesKey = JSON.stringify(placesRaw);
  const places = useMemo(() => JSON.parse(placesKey) as Place[], [placesKey]);

  const locate = async (targets?: string[]) => {
    try {
      const res = await client.requestLocations(targets);
      const t0 = Date.now();
      setNow(t0);
      setCooldownUntil(t0 + res.cooldown * 1000);
      setTimeout(() => setNow(Date.now()), res.cooldown * 1000 + 100);
    } catch (e) {
      Alert.alert('Couldn’t ask for locations', errorText(e));
    }
  };
  const cooling = now < cooldownUntil;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ flex: 1.15 }}>
        <FamilyMap
          tileUrl={tiles.tileUrl}
          attribution={tiles.tileAttribution}
          members={mapMembers}
          places={places}
          focus={focus}
          dark={t.dark}
          onMemberPress={(id) => {
            const loc = client.locations.get(id);
            if (loc) setFocus((f) => ({ lat: loc.lat, lng: loc.lng, key: (f?.key ?? 0) + 1 }));
          }}
        />
        <SafeAreaView edges={['top']} style={{ position: 'absolute', left: 12, right: 12, top: 0 }} pointerEvents="box-none">
          <View
            style={{
              alignSelf: 'flex-start',
              backgroundColor: t.surface,
              borderRadius: 999,
              paddingHorizontal: 14,
              paddingVertical: 8,
              marginTop: 8,
              shadowColor: '#000',
              shadowOpacity: 0.12,
              shadowRadius: 8,
              elevation: 3,
            }}
          >
            <CircleSwitcher />
          </View>
          <ServerBanner style={{ marginTop: 10 }} />
        </SafeAreaView>
      </View>
      <View style={{ flex: 1, backgroundColor: t.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, marginTop: -18, paddingTop: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, marginBottom: 6 }}>
          <Text style={{ flex: 1, color: t.text, fontSize: 20, fontWeight: '700' }}>People</Text>
          <Button title={cooling ? 'Asked' : 'Refresh everyone'} small variant="primary" disabled={cooling || members.length < 2} onPress={() => locate()} />
        </View>
        <FlatList
          data={members}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24 }}
          ListEmptyComponent={
            <Text style={{ color: t.muted, padding: 8, lineHeight: 20 }}>
              {server.reachable ? 'Loading your circle…' : 'Your circle will show up here once your server is reachable again.'}
            </Text>
          }
          ListFooterComponent={
            members.length === 1 ? (
              <Text style={{ color: t.muted, padding: 8, lineHeight: 20 }}>It’s just you so far. Invite your family from Settings.</Text>
            ) : undefined
          }
          renderItem={({ item: m }) => {
            const loc = client.locations.get(m.id);
            const place = placeAt(loc, client.places);
            const bits: string[] = [];
            if (loc) {
              bits.push(place ? `At ${place.name}` : `±${Math.round(loc.accuracy || 0)} m`);
              bits.push(timeAgo(loc.ts));
              if (loc.battery != null) bits.push(`${Math.round(loc.battery * 100)}%${loc.charging ? ' ⚡' : ''}`);
            } else {
              bits.push(m.isMe ? 'Not shared yet' : 'No location yet');
            }
            return (
              <Pressable
                onPress={() => loc && setFocus({ lat: loc.lat, lng: loc.lng, key: (focus?.key ?? 0) + 1 })}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 8, borderRadius: 14, backgroundColor: pressed ? t.surface2 : 'transparent' })}
              >
                <Avatar name={m.name} color={m.color} />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ color: t.text, fontWeight: '700', fontSize: 16 }} numberOfLines={1}>
                      {m.name}
                    </Text>
                    {m.isMe ? <Tag label="You" /> : null}
                    {m.keyChanged ? <Tag label="Keys changed" warn /> : !m.verified ? <Tag label="Unverified" warn /> : null}
                  </View>
                  <Text style={{ color: t.muted, fontSize: 14, marginTop: 2 }} numberOfLines={1}>
                    {bits.join(' · ')}
                  </Text>
                </View>
                {!m.isMe ? <Button title="Locate" small disabled={cooling} onPress={() => locate([m.id])} /> : null}
              </Pressable>
            );
          }}
        />
      </View>
    </View>
  );
}
