import { useEffect, useState } from 'react';
import { Alert, Keyboard, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import { randomId, type CircleClient, type Place } from '@homecircle/core';
import { FamilyMap } from '../map/FamilyMap';
import { Button, ErrorText } from '../components/ui';
import { allClients, errorText, getClient } from '../lib/circle';
import { DEFAULT_SETTINGS, getSettings } from '../lib/storage';
import { feetToMeters, metersToFeet } from '../lib/units';
import { useTheme } from '../theme';

const RADII_FT = [500, 1000, 2000, 5000];
// Phones can't reliably tell smaller areas apart (GPS drift, and the OS
// watches geofences of at least ~150 m), so arrivals would be missed.
const MIN_FT = 500;
const MAX_FT = 16000; // ~5 km

function formatAddress(a: Location.LocationGeocodedAddress | undefined) {
  if (!a) return null;
  const street = [a.streetNumber, a.street].filter(Boolean).join(' ');
  return [street || a.name, a.city, a.region].filter(Boolean).join(', ') || null;
}

/** A place being edited: every copy of it (one per circle it was added to). */
function placeToEdit(circleId: string | undefined, id: string | undefined): { place: Place; copies: { client: CircleClient; place: Place }[] } | null {
  const circles = allClients();
  const place = circles.find((c) => c.circleId === circleId)?.places.get(id ?? '');
  if (!place) return null;
  const copies = place.group
    ? circles.flatMap((client) => [...client.places.values()].filter((p) => p.group === place.group).map((p) => ({ client, place: p })))
    : [{ client: circles.find((c) => c.circleId === circleId)!, place }];
  return { place, copies };
}

/** A map zoom at which a circle of this radius fits the map, with room around it. */
function zoomFor(lat: number, meters: number) {
  const z = Math.log2((156543 * Math.cos((lat * Math.PI) / 180) * 170) / (2 * Math.max(meters, 1)));
  return Math.max(12, Math.min(18, Math.floor(z)));
}

/** A radius in feet: one of the chips when it's close to one, else the custom field.
 *  Older places can be under today's minimum: those start at the smallest chip. */
function radiusFields(meters: number) {
  const ft = Math.max(MIN_FT, Math.round(metersToFeet(meters)));
  const chip = RADII_FT.find((r) => Math.abs(r - ft) <= 5);
  return chip ? { feet: chip, custom: '' } : { feet: 500, custom: String(ft) };
}

/** Add a place, or edit one (opened with ?circle=…&id=…, by tapping it in Places). */
export default function AddPlace() {
  const t = useTheme();
  const params = useLocalSearchParams<{ circle?: string; id?: string }>();
  const [editing] = useState(() => placeToEdit(params.circle, params.id));
  const circles = allClients();
  const [tiles, setTiles] = useState(DEFAULT_SETTINGS);
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(editing ? { lat: editing.place.lat, lng: editing.place.lng } : null);
  const [focus, setFocus] = useState<{ lat: number; lng: number; zoom: number; key: number } | null>(
    editing ? { lat: editing.place.lat, lng: editing.place.lng, zoom: 16, key: 1 } : null,
  );
  const [query, setQuery] = useState('');
  const [address, setAddress] = useState<string | null>(editing?.place.address ?? null);
  const [name, setName] = useState(editing?.place.name ?? '');
  const [feet, setFeet] = useState(editing ? radiusFields(editing.place.radius).feet : 500);
  const [customFeet, setCustomFeet] = useState(editing ? radiusFields(editing.place.radius).custom : '');
  const [everywhere, setEverywhere] = useState(true);
  const [busy, setBusy] = useState<'find' | 'save' | 'here' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then(setTiles);
    if (editing) return;
    // Open on the phone's own position, not the world: the last one it knows, else a fresh fix.
    let alive = true;
    const show = (l: Location.LocationObject | null) => {
      if (l && alive) setFocus({ lat: l.coords.latitude, lng: l.coords.longitude, zoom: 16, key: Date.now() });
    };
    Location.getLastKnownPositionAsync()
      .then(async (l) => {
        if (l) return show(l);
        const { granted } = await Location.getForegroundPermissionsAsync();
        if (granted) show(await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [editing]);

  const radiusFeet = customFeet ? Number(customFeet) : feet;
  const radiusOk = Number.isFinite(radiusFeet) && radiusFeet >= MIN_FT && radiusFeet <= MAX_FT;

  const place = async (p: { lat: number; lng: number }, label?: string | null, radiusM = feetToMeters(radiusOk ? radiusFeet : feet)) => {
    setPoint(p);
    setFocus({ ...p, zoom: zoomFor(p.lat, radiusM), key: Date.now() });
    if (label !== undefined) return setAddress(label);
    // Show which address a tapped point is, when the phone can tell.
    const found = await Location.reverseGeocodeAsync({ latitude: p.lat, longitude: p.lng }).catch(() => []);
    setAddress(formatAddress(found[0]));
  };

  // Drops the pin where the phone is now.
  const here = async () => {
    setBusy('here');
    setError(null);
    try {
      const { granted } = await Location.requestForegroundPermissionsAsync();
      if (!granted) throw new Error('Allow location for HomeCircle in your phone’s settings, or tap the map.');
      const l = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      await place({ lat: l.coords.latitude, lng: l.coords.longitude });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  // Show the whole circle again after the radius changes.
  const fit = (feetNow: number) => {
    if (point && feetNow >= MIN_FT && feetNow <= MAX_FT) setFocus({ ...point, zoom: zoomFor(point.lat, feetToMeters(feetNow)), key: Date.now() });
  };

  const remove = () => {
    if (!editing) return;
    const copies = editing.copies;
    Alert.alert(
      `Delete ${editing.place.name}?`,
      copies.length > 1
        ? `Arrival alerts for this place stop for everyone in ${copies.map((c) => c.client.circle.name).join(' and ')}.`
        : 'Arrival alerts for this place stop for everyone in the circle.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setBusy('delete');
            try {
              await Promise.all(copies.map((c) => c.client.deletePlace(c.place.id)));
              router.back();
            } catch (e) {
              setError(errorText(e));
              setBusy(null);
            }
          },
        },
      ],
    );
  };

  const find = async () => {
    if (!query.trim()) return;
    Keyboard.dismiss();
    setBusy('find');
    setError(null);
    try {
      // Uses the phone's built-in geocoder (Google on Android, Apple on iOS).
      const results = await Location.geocodeAsync(query.trim());
      if (!results.length) throw new Error('Couldn’t find that address. Try adding the city, or tap the map.');
      const r = results[0];
      const back = await Location.reverseGeocodeAsync({ latitude: r.latitude, longitude: r.longitude }).catch(() => []);
      await place({ lat: r.latitude, lng: r.longitude }, formatAddress(back[0]) || query.trim());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!point || !radiusOk) return;
    setBusy('save');
    setError(null);
    try {
      const radius = Math.round(feetToMeters(radiusFeet));
      // Editing: every circle's copy of the place changes, keeping its id
      // (so alerts and "here now" carry on) and its group.
      // Adding: one place can be shared with every circle; each gets its own
      // encrypted copy, linked by a group id so the phone watches it once.
      const group = randomId(9);
      const results = await Promise.allSettled(
        editing
          ? editing.copies.map(({ client, place: p }) => client.savePlace({ id: p.id, name, lat: point.lat, lng: point.lng, radius, address, group: p.group ?? null }))
          : (everywhere ? circles : [getClient()]).map((c) => c.savePlace({ name, lat: point.lat, lng: point.lng, radius, address, group })),
      );
      const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      if (failed.length === results.length) throw failed[0].reason;
      router.back();
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
    }
  };

  const chip = (on: boolean) => ({
    minHeight: 44,
    paddingHorizontal: 16,
    justifyContent: 'center' as const,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: on ? t.brand : t.line,
    backgroundColor: on ? t.brandSoft : 'transparent',
  });
  const input = {
    backgroundColor: t.bg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.line,
    paddingHorizontal: 14,
    minHeight: 52,
    fontSize: 17,
    color: t.text,
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {editing ? <Stack.Screen options={{ title: `Edit ${editing.place.name}` }} /> : null}
      <View style={{ height: 260 }}>
        <FamilyMap
          tileUrl={tiles.tileUrl}
          attribution={tiles.tileAttribution}
          pickMode
          picked={point ? { ...point, radius: feetToMeters(radiusOk ? radiusFeet : feet) } : null}
          onPick={(p) => place(p)}
          focus={focus}
          dark={t.dark}
        />
      </View>
      <ScrollView style={{ backgroundColor: t.surface }} contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>Address</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="123 Main St, San Jose"
            placeholderTextColor={t.muted}
            returnKeyType="search"
            onSubmitEditing={find}
            autoCorrect={false}
            style={[input, { flex: 1 }]}
          />
          <Button title="Find" loading={busy === 'find'} disabled={!query.trim()} onPress={find} />
        </View>
        <Button title="Use where I am" loading={busy === 'here'} onPress={here} />
        <Text style={{ color: point ? t.text : t.muted, fontSize: 15 }}>
          {point ? `📍 ${address || 'Pinned on the map'}` : 'Or tap the map to drop the place.'}
        </Text>

        <Text style={{ color: t.text, fontSize: 15, fontWeight: '700', marginTop: 4 }}>Name</Text>
        <TextInput value={name} onChangeText={setName} placeholder="Home, School, Work…" placeholderTextColor={t.muted} maxLength={40} style={input} />

        <Text style={{ color: t.text, fontSize: 15, fontWeight: '700', marginTop: 4 }}>Radius</Text>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {RADII_FT.map((ft) => (
            <Pressable
              key={ft}
              accessibilityRole="button"
              accessibilityState={{ selected: !customFeet && ft === feet }}
              onPress={() => {
                setFeet(ft);
                setCustomFeet('');
                fit(ft);
              }}
              style={chip(!customFeet && ft === feet)}
            >
              <Text style={{ color: !customFeet && ft === feet ? t.brand : t.text, fontWeight: '600', fontSize: 16 }}>{ft.toLocaleString()} ft</Text>
            </Pressable>
          ))}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <TextInput
            value={customFeet}
            onChangeText={(v) => setCustomFeet(v.replace(/[^0-9]/g, ''))}
            placeholder="Other"
            placeholderTextColor={t.muted}
            keyboardType="number-pad"
            maxLength={5}
            onEndEditing={() => customFeet && fit(Number(customFeet))}
            style={[input, { width: 120 }]}
          />
          <Text style={{ color: t.muted, fontSize: 16 }}>feet</Text>
        </View>
        {!radiusOk ? (
          <Text style={{ color: t.danger, fontSize: 14 }}>Use between {MIN_FT} and {MAX_FT.toLocaleString()} feet.</Text>
        ) : (
          <Text style={{ color: t.muted, fontSize: 13 }}>500 ft or more: phones can’t reliably detect smaller areas, so arrivals would be missed.</Text>
        )}

        {editing && editing.copies.length > 1 ? (
          <Text style={{ color: t.muted, fontSize: 14 }}>Changes apply in {editing.copies.map((c) => c.client.circle.name).join(', ')}.</Text>
        ) : null}
        {!editing && circles.length > 1 ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Add to all my circles</Text>
              <Text style={{ color: t.muted, fontSize: 14 }}>
                {everywhere ? 'Everyone in each of your circles gets alerts for it, in that circle’s chat.' : `Only ${getClient().circle.name}.`}
              </Text>
            </View>
            <Switch value={everywhere} onValueChange={setEverywhere} trackColor={{ true: t.brand }} />
          </View>
        ) : null}

        <Button title={editing ? 'Save changes' : 'Save place'} variant="primary" loading={busy === 'save'} disabled={!point || !name.trim() || !radiusOk} onPress={save} style={{ marginTop: 6 }} />
        {editing ? <Button title="Delete place" variant="danger" loading={busy === 'delete'} onPress={remove} /> : null}
        <ErrorText>{error}</ErrorText>
        <Text style={{ color: t.muted, fontSize: 13 }}>
          The address is looked up by your phone’s map service. Places are stored end-to-end encrypted, so your HomeCircle server never learns where they are.
        </Text>
      </ScrollView>
    </View>
  );
}
