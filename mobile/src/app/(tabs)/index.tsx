import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, FlatList, Pressable, Text, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { needsAttention, setupChecklist } from '../../lib/health';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Place } from '@homecircle/core';
import { FamilyMap, type MapInset, type MapMember, type MapView } from '../../map/FamilyMap';
import { EmptyState, Icon, IconButton, Tag } from '../../components/ui';
import { MemberAvatar } from '../../components/MemberAvatar';
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
import { initials, useAllCircles, useCircle } from '../../lib/useCircle';
import { chirpWithChoice } from '../../lib/chirp';
import { canLocate, everyoneCoolingDown, isAsking, memberState, locatePerson, locateState, lowBattery, refreshEveryone, settingWarning, statusLine, useLocateVersion } from '../../lib/people';
import { DEFAULT_SETTINGS, getSettings } from '../../lib/storage';
import { edgeChips, groups, openingFrame } from '../../lib/mapFrame';
import { usePlaceNames } from '../../lib/weather';
import { useTheme } from '../../theme';

const STALE_MS = 2 * 3600_000;
// The People drawer: just its handle and header when closed.
const DRAWER_CLOSED = 78;
// The SOS button and the room around it, kept clear of pins and chips.
const SOS_ROOM = 64 + 16 + 8;
// A chip for people out of view: its box (it hugs the edge it's on).
const CHIP_W = 168;
const CHIP_H = 36;

export default function MapTab() {
  const t = useTheme();
  const client = useCircle();
  // Places only while a circle on this phone shares locations.
  const circles = useAllCircles(['circle']);
  const anySharing = !circles.length || circles.some((c) => c.feature('locationSharing'));
  const server = useServerState();
  const [tiles, setTiles] = useState(DEFAULT_SETTINGS);
  const [focus, setFocus] = useState<{ lat: number; lng: number; key: number } | null>(null);
  const [fitTo, setFitTo] = useState<{ points: { lat: number; lng: number }[]; key: number } | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  // What covers the map: the bar on top, and the person sheet (0 when closed).
  const [topH, setTopH] = useState(0);
  const [sheetH, setSheetH] = useState(0);
  // Where the map is, for the chips at its edge.
  const [mapView, setMapView] = useState<MapView | null>(null);
  // The person last tapped on the map or in People: the weather tile shows where they are.
  const [selected, setSelected] = useState<string | null>(null);
  // Clock for "5 min ago" labels and Locate progress.
  const [now, setNow] = useState(() => Date.now());
  useLocateVersion();
  // People pull up from the bottom; pushed down, the map has the whole screen.
  const { height: screenH } = useWindowDimensions();
  const drawerOpenH = Math.round(screenH * 0.42);
  const drawer = useDrawer(DRAWER_CLOSED, drawerOpenH);

  // The circle's name and the plugin tile share the top row only when both fit
  // whole; a long name, or the big tile, puts the tile on its own line below.
  const [widths, setWidths] = useState({ row: 0, pill: 0, tile: 0 });
  const measure = (k: 'row' | 'pill' | 'tile') => (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    setWidths((cur) => (cur[k] === w ? cur : { ...cur, [k]: w }));
  };
  const tileBeside = !widths.tile || widths.pill + 8 + widths.tile <= widths.row;

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

  // The map opens on the people near you, not on everyone (Nani abroad would
  // squash your whole town into one blob); with sharing off, on the places.
  const meId = client.account?.memberId ?? null;
  const frame = useMemo(() => {
    // (Only with sharing off: else it waits for people, as it fits just once.)
    if (!sharing) return openingFrame(places, null).frame;
    return openingFrame(
      mapMembers.map((m) => ({ id: m.id, lat: m.lat, lng: m.lng, ts: client.locations.get(m.id)?.ts })),
      meId,
    ).frame;
    // Locations are read for their age only, to break ties.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharing, mapMembers, places, meId]);
  const mapGroups = useMemo(() => groups(mapMembers), [mapMembers]);

  // Fits and fly-tos keep clear of the top bar, the drawer or the person sheet, and the SOS button.
  const sos = client.feature('sos');
  const drawerH = drawer.open ? drawerOpenH : DRAWER_CLOSED;
  // Before the sheet has been measured: what it took last time, or about that.
  const [sheetLast, setSheetLast] = useState(() => Math.round(screenH * 0.42));
  const onSheetHeight = useCallback((h: number) => {
    setSheetH(h);
    if (h) setSheetLast(h);
  }, []);
  const coveredBelow = sheet ? Math.max(sheetH || sheetLast, drawerH) : drawerH;
  const inset: MapInset = useMemo(
    () => ({ top: topH, right: 0, left: 0, bottom: coveredBelow + (sheet || !sos ? 0 : SOS_ROOM) }),
    [topH, coveredBelow, sheet, sos],
  );

  const everyoneCooling = everyoneCoolingDown(client, now);
  // A person tapped: fly them to the middle of the map above the sheet.
  const lastFocus = useRef<{ id: string; at: number; bottom: number } | null>(null);
  const focusOn = (id: string) => {
    setSelected(id);
    const loc = client.locations.get(id);
    lastFocus.current = { id, at: Date.now(), bottom: Math.max(sheetH || sheetLast, drawerH) };
    if (loc) setFocus((f) => ({ lat: loc.lat, lng: loc.lng, key: (f?.key ?? 0) + 1 }));
  };
  // The sheet came out a different height than guessed: center them again, if that was just now.
  useEffect(() => {
    const f = lastFocus.current;
    if (!sheet || !sheetH || !f || f.id !== sheet || Date.now() - f.at > 1500 || Math.abs(coveredBelow - f.bottom) < 24) return;
    f.bottom = coveredBelow;
    const loc = client.locations.get(f.id);
    if (loc) setFocus((cur) => ({ lat: loc.lat, lng: loc.lng, key: (cur?.key ?? 0) + 1 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coveredBelow]);

  // People out of view: a chip at the edge of the map, pointing their way.
  const chips = useMemo(() => {
    if (!mapView || !mapView.w || !mapView.h) return [];
    const visible = { left: 0, top: topH, right: mapView.w, bottom: mapView.h - coveredBelow };
    if (visible.bottom - visible.top < CHIP_H * 3) return [];
    const area = { left: 8, top: topH + 8, right: mapView.w - 8, bottom: mapView.h - inset.bottom - 8 };
    const placed = mapGroups.map((g) => g.flatMap((m) => (mapView.pts[m.id] ? [{ id: m.id, x: mapView.pts[m.id][0], y: mapView.pts[m.id][1] }] : [])));
    return edgeChips(placed, visible, area, CHIP_W, CHIP_H);
  }, [mapView, mapGroups, topH, coveredBelow, inset.bottom]);
  const chipWhere = usePlaceNames(
    client,
    chips.map((c) => client.locations.get(c.ids[0])),
  );
  const chipLabel = (ids: string[], where: string | null) => {
    const name = ids[0] === meId ? 'You' : client.displayName(ids[0]);
    const who = ids.length > 1 ? `${name} +${ids.length - 1}` : name;
    return where ? `${who} · ${where}` : who;
  };
  const flyToChip = (ids: string[]) => {
    if (ids.length === 1) setSelected(ids[0]);
    const points = ids.flatMap((id) => {
      const loc = client.locations.get(id);
      return loc ? [{ lat: loc.lat, lng: loc.lng }] : [];
    });
    if (points.length) setFitTo((f) => ({ points, key: (f?.key ?? 0) + 1 }));
  };

  // Below the row, it clears "Fix setup" (which hangs under the circle's name).
  const pluginTiles = (
    <View onLayout={measure('tile')} pointerEvents="box-none" style={{ alignSelf: 'flex-end', marginTop: !tileBeside && setupIssues ? 36 : 8 }}>
      <PluginTiles client={client} memberId={selected} />
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ flex: 1 }}>
        <FamilyMap
          tileUrl={tiles.tileUrl}
          fitKey={client.circleId}
          attribution={tiles.tileAttribution}
          members={mapMembers}
          places={places}
          frame={frame}
          inset={inset}
          focus={focus}
          fitTo={fitTo}
          dark={t.dark}
          onMemberPress={(id) => {
            focusOn(id);
            setSheet(id);
          }}
          onPlacePress={(id) => router.push({ pathname: '/add-place', params: { circle: client.circleId!, id } })}
          onView={setMapView}
        />
        {chips.map((c, i) => (
          <View
            key={c.ids.join(',')}
            pointerEvents="box-none"
            style={{
              position: 'absolute',
              left: c.left,
              top: c.top,
              width: CHIP_W,
              height: CHIP_H,
              justifyContent: 'center',
              alignItems: c.side === 'left' ? 'flex-start' : c.side === 'right' ? 'flex-end' : 'center',
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${chipLabel(c.ids, chipWhere[i])}, off the map`}
              accessibilityHint="Shows them on the map"
              onPress={() => flyToChip(c.ids)}
              hitSlop={6}
              style={({ pressed }) => ({
                maxWidth: CHIP_W,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingLeft: 8,
                paddingRight: 12,
                height: 32,
                borderRadius: 16,
                backgroundColor: pressed ? t.surface2 : t.surface,
                shadowColor: '#000',
                shadowOpacity: 0.15,
                shadowRadius: 6,
                elevation: 4,
              })}
            >
              {/* The arrow icon points up and right; turn it their way. */}
              <View style={{ transform: [{ rotate: `${Math.round(c.angle + 45)}deg` }] }}>
                <Icon name="navigate" color={t.brand} size={16} />
              </View>
              <Text style={{ color: t.text, fontSize: 14, fontWeight: '600', flexShrink: 1 }} numberOfLines={1}>
                {chipLabel(c.ids, chipWhere[i])}
              </Text>
            </Pressable>
          </View>
        ))}
        <SafeAreaView
          edges={['top']}
          onLayout={(e) => setTopH(Math.round(e.nativeEvent.layout.y + e.nativeEvent.layout.height))}
          style={{ position: 'absolute', left: 12, right: 12, top: 0 }}
          pointerEvents="box-none"
        >
          <View onLayout={measure('row')} style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }} pointerEvents="box-none">
            <View
              onLayout={measure('pill')}
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
                <Text style={{ fontSize: 14 }}>⚠️</Text>
                <Text style={{ color: t.warnText, fontWeight: '700', fontSize: 14 }}>Fix setup{setupIssues > 1 ? ` · ${setupIssues}` : ''}</Text>
              </Pressable>
            ) : null}
            {/* The plugins' tiles, if this circle has any: top right, beside the circle's name when both fit. */}
            {tileBeside ? pluginTiles : null}
          </View>
          {/* A long circle name, or the big tile: the tile goes on its own line below, still on the right (and below "Fix setup"). */}
          {tileBeside ? null : pluginTiles}
          <SosBanner style={{ marginTop: setupIssues && tileBeside ? 36 : 10 }} />
          <ServerBanner style={{ marginTop: 10 }} />
          <RejoinBanner style={{ marginTop: 10 }} />
          <UpdateBanner style={{ marginTop: 10 }} />
        </SafeAreaView>
      </View>
      {/* The button follows the circle on screen, just above the drawer; an SOS goes to every circle on this phone that has it on. */}
      {sos ? (
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
            {anySharing ? (
              <View style={{ marginRight: 8 }}>
                <IconButton icon="place" label="Places" onPress={() => router.push('/places')} />
              </View>
            ) : null}
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
              <EmptyState icon="users" text="It’s just you so far." action="Invite someone" onAction={() => router.push('/invite')} />
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
                accessibilityHint="Call, message, directions and more"
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 8, borderRadius: 14, backgroundColor: pressed ? t.surface2 : 'transparent' })}
              >
                <MemberAvatar client={client} member={m} />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Text style={{ color: t.text, fontWeight: '700', fontSize: 17 }} numberOfLines={1}>
                      {m.name}
                    </Text>
                    {m.isMe ? <Tag label="You" /> : null}
                    {lowBattery(loc) ? <Tag label="Low battery" warn /> : null}
                    {/* The setting that slows their updates, as a tag: the line below is cut to one row. */}
                    {settingWarning(client, m, now) ? <Tag label={settingWarning(client, m, now)!} warn /> : null}
                    {m.keyChanged ? <Tag label="Keys changed" warn /> : !m.verified ? <Tag label="Unverified" warn /> : null}
                  </View>
                  <Text style={{ color: t.muted, fontSize: 14, marginTop: 2, lineHeight: 19 }} numberOfLines={1}>
                    {statusLine(client, m, now, { warnings: false })}
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
      <PersonSheet
        client={client}
        memberId={sheet}
        onClose={() => setSheet(null)}
        onHeight={onSheetHeight}
        onShowSpot={(p) => {
          setSheet(null);
          setFocus((f) => ({ lat: p.lat, lng: p.lng, key: (f?.key ?? 0) + 1 }));
        }}
      />
    </View>
  );
}
