import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Place } from '@homecircle/core';
import { FamilyMap, type MapMember } from '../../map/FamilyMap';
import { Avatar, Button, IconButton, Tag } from '../../components/ui';
import { ServerBanner } from '../../components/ServerBanner';
import { CircleSwitcher } from '../../components/CircleSwitcher';
import { PersonSheet } from '../../components/PersonSheet';
import { useServerState } from '../../lib/connection';
import { initials, useCircle } from '../../lib/useCircle';
import { everyoneCoolingDown, locatePerson, locateState, lowBattery, refreshEveryone, statusLine, useLocateVersion } from '../../lib/people';
import { DEFAULT_SETTINGS, getSettings } from '../../lib/storage';
import { useTheme } from '../../theme';

const STALE_MS = 2 * 3600_000;

export default function MapTab() {
  const t = useTheme();
  const client = useCircle();
  const server = useServerState();
  const [tiles, setTiles] = useState(DEFAULT_SETTINGS);
  const [focus, setFocus] = useState<{ lat: number; lng: number; key: number } | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  // Clock for "5 min ago" labels and Locate progress.
  const [now, setNow] = useState(() => Date.now());
  useLocateVersion();

  useEffect(() => {
    getSettings().then(setTiles);
    const timer = setInterval(() => setNow(Date.now()), 15_000);
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
        approximate: loc.approximate,
      },
    ];
  });
  const membersKey = JSON.stringify(mapMembersRaw);
  const mapMembers = useMemo(() => JSON.parse(membersKey) as MapMember[], [membersKey]);
  const placesRaw = [...client.places.values()];
  const placesKey = JSON.stringify(placesRaw);
  const places = useMemo(() => JSON.parse(placesKey) as Place[], [placesKey]);

  const everyoneCooling = everyoneCoolingDown(client, now);
  const focusOn = (id: string) => {
    const loc = client.locations.get(id);
    if (loc) setFocus((f) => ({ lat: loc.lat, lng: loc.lng, key: (f?.key ?? 0) + 1 }));
  };

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
            focusOn(id);
            setSheet(id);
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
          <Button
            title={everyoneCooling ? 'Asked everyone' : 'Refresh everyone'}
            small
            variant="primary"
            disabled={everyoneCooling || members.length < 2}
            onPress={() => refreshEveryone(client)}
          />
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
            const paused = client.paused.get(m.id);
            const state = locateState(client, m.id, now);
            const loc = client.locations.get(m.id);
            return (
              <Pressable
                onPress={() => {
                  focusOn(m.id);
                  setSheet(m.id);
                }}
                accessibilityRole="button"
                accessibilityHint="Shows directions, Locate, check in and message"
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 8, borderRadius: 14, backgroundColor: pressed ? t.surface2 : 'transparent' })}
              >
                <Avatar name={m.name} color={m.color} />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Text style={{ color: t.text, fontWeight: '700', fontSize: 17 }} numberOfLines={1}>
                      {m.name}
                    </Text>
                    {m.isMe ? <Tag label="You" /> : null}
                    {lowBattery(loc) ? <Tag label="Low battery" warn /> : null}
                    {m.keyChanged ? <Tag label="Keys changed" warn /> : !m.verified ? <Tag label="Unverified" warn /> : null}
                  </View>
                  <Text style={{ color: t.muted, fontSize: 14, marginTop: 2, lineHeight: 19 }} numberOfLines={2}>
                    {state === 'asking' ? 'Asking for a fresh location…' : statusLine(client, m)}
                  </Text>
                </View>
                {!m.isMe ? (
                  <IconButton
                    icon="locate"
                    label={`Locate ${m.name}`}
                    busy={state === 'asking'}
                    done={state === 'updated'}
                    disabled={!!paused || state === 'cooldown'}
                    onPress={() => locatePerson(client, m.id)}
                  />
                ) : null}
              </Pressable>
            );
          }}
        />
      </View>
      <PersonSheet client={client} memberId={sheet} onClose={() => setSheet(null)} />
    </View>
  );
}
