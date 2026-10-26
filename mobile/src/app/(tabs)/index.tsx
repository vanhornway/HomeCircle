import { useCallback, useEffect, useMemo, useState } from 'react';
import { Animated, AppState, FlatList, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { needsAttention, setupChecklist } from '../../lib/health';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Place } from '@homecircle/core';
import { FamilyMap, type MapMember } from '../../map/FamilyMap';
import { Avatar, IconButton, Tag } from '../../components/ui';
import { ServerBanner } from '../../components/ServerBanner';
import { CircleSwitcher } from '../../components/CircleSwitcher';
import { UpdateBanner } from '../../components/UpdateBanner';
import { SosBanner } from '../../components/SosBanner';
import { SosButton } from '../../components/SosButton';
import { PluginTiles } from '../../components/PluginTiles';
import { RejoinBanner } from '../../components/RejoinBanner';
import { PersonSheet } from '../../components/PersonSheet';
import { Drawer, useDrawer } from '../../components/Drawer';
import { useServerState } from '../../lib/connection';
import { initials, useCircle } from '../../lib/useCircle';
import { chirpWithChoice } from '../../lib/chirp';
import { canLocate, everyoneCoolingDown, isAsking, memberState, locatePerson, locateState, lowBattery, refreshEveryone, statusLine, useLocateVersion } from '../../lib/people';
import { DEFAULT_SETTINGS, getSettings } from '../../lib/storage';
import { useTheme } from '../../theme';

const STALE_MS = 2 * 3600_000;
// The People drawer: just its handle and header when closed.
const DRAWER_CLOSED = 78;

export default function MapTab() {
  const t = useTheme();
  const client = useCircle();
  const server = useServerState();
  const [tiles, setTiles] = useState(DEFAULT_SETTINGS);
  const [focus, setFocus] = useState<{ lat: number; lng: number; key: number } | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  // The person last tapped on the map or in People: the weather tile shows where they are.
  const [selected, setSelected] = useState<string | null>(null);
  // Clock for "5 min ago" labels and Locate progress.
  const [now, setNow] = useState(() => Date.now());
  useLocateVersion();
  // People pull up from the bottom; pushed down, the map has the whole screen.
  const { height: screenH } = useWindowDimensions();
  const drawer = useDrawer(DRAWER_CLOSED, Math.round(screenH * 0.42));

  // Re-check this phone's setup on every open (and when coming back to the app).
  const [setupIssues, setSetupIssues] = useState(0);
  useFocusEffect(
    useCallback(() => {
      setupChecklist()
        .then((items) => setSetupIssues(needsAttention(items).length))
        .catch(() => {});
      const sub = AppState.addEventListener('change', (st) => {
        if (st === 'active') setupChecklist().then((items) => setSetupIssues(needsAttention(items).length)).catch(() => {});
      });
      return () => sub.remove();
    }, []),
  );

  useEffect(() => {
    getSettings().then(setTiles);
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const members = client.memberList();
  // Circle data is mutated in place, so memoize on content rather than identity.
  const sharing = client.feature('locationSharing');
  const mapMembersRaw: MapMember[] = members.flatMap((m) => {
    const loc = sharing ? client.locations.get(m.id) : null;
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
        badge: { saver: '🔋', settings: '⚠️', 'last-gasp': '🪫' }[memberState(client, m, now) as string],
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
    setSelected(id);
    const loc = client.locations.get(id);
    if (loc) setFocus((f) => ({ lat: loc.lat, lng: loc.lng, key: (f?.key ?? 0) + 1 }));
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ flex: 1 }}>
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
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }} pointerEvents="box-none">
            <View
              style={{
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
            {setupIssues ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Setup needs attention: ${setupIssues} setting${setupIssues === 1 ? '' : 's'} may stop your location from updating. Tap to fix.`}
                onPress={() => router.push('/setup-check')}
                hitSlop={6}
                style={{ position: 'absolute', left: 0, top: 58, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: t.warnBg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }}
              >
                <Text style={{ fontSize: 12 }}>⚠️</Text>
                <Text style={{ color: t.warnText, fontWeight: '700', fontSize: 13 }}>Fix setup{setupIssues > 1 ? ` · ${setupIssues}` : ''}</Text>
              </Pressable>
            ) : null}
            {/* The plugins' tiles (weather, air and pollen), if this circle has any: always the top-right corner. */}
            <View style={{ marginTop: 8 }}>
              <PluginTiles client={client} memberId={selected} />
            </View>
          </View>
          <SosBanner style={{ marginTop: setupIssues ? 36 : 10 }} />
          <ServerBanner style={{ marginTop: 10 }} />
          <RejoinBanner style={{ marginTop: 10 }} />
          <UpdateBanner style={{ marginTop: 10 }} />
        </SafeAreaView>
      </View>
      {/* The button follows the circle on screen, just above the drawer; an SOS goes to every circle on this phone that has it on. */}
      {client.feature('sos') ? (
        <Animated.View pointerEvents="box-none" style={{ position: 'absolute', right: 16, bottom: Animated.add(drawer.motion.height, 16) }}>
          <SosButton />
        </Animated.View>
      ) : null}
      <Drawer
        drawer={drawer}
        header={
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 8 }}>
            <Text style={{ flex: 1, color: t.text, fontSize: 20, fontWeight: '700' }}>
              People{members.length > 1 ? <Text style={{ color: t.muted, fontWeight: '600' }}> · {members.length}</Text> : null}
            </Text>
            {client.feature('chirps') ? (
              <View style={{ marginRight: 8 }}>
                <IconButton icon="birds" label="Chirp everyone" disabled={members.length < 2} onPress={() => chirpWithChoice(client, null)} />
              </View>
            ) : null}
            {/* Just an icon, to leave room in this row for more. */}
            {client.feature('locate') ? (
              <IconButton
                icon="refresh"
                primary
                label={everyoneCooling ? 'Asked everyone for a fresh location' : 'Refresh everyone’s location'}
                done={everyoneCooling}
                disabled={everyoneCooling || members.length < 2}
                onPress={() => refreshEveryone(client)}
              />
            ) : null}
          </View>
        }
      >
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
                    {statusLine(client, m, now)}
                  </Text>
                </View>
                {!m.isMe && client.feature('locate') ? (
                  <IconButton
                    icon="locate"
                    label={`Locate ${m.name}`}
                    busy={isAsking(state)}
                    done={state === 'updated'}
                    disabled={!!paused || !canLocate(state)}
                    onPress={() => locatePerson(client, m.id)}
                  />
                ) : null}
              </Pressable>
            );
          }}
        />
      </Drawer>
      <PersonSheet client={client} memberId={sheet} onClose={() => setSheet(null)} />
    </View>
  );
}
