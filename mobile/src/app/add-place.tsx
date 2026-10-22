import { useEffect, useState } from 'react';
import { Keyboard, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import * as Location from 'expo-location';
import { randomId } from '@homecircle/core';
import { FamilyMap } from '../map/FamilyMap';
import { Button, ErrorText } from '../components/ui';
import { allClients, errorText, getClient } from '../lib/circle';
import { DEFAULT_SETTINGS, getSettings } from '../lib/storage';
import { feetToMeters } from '../lib/units';
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

export default function AddPlace() {
  const t = useTheme();
  const circles = allClients();
  const [tiles, setTiles] = useState(DEFAULT_SETTINGS);
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [focus, setFocus] = useState<{ lat: number; lng: number; zoom: number; key: number } | null>(null);
  const [query, setQuery] = useState('');
  const [address, setAddress] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [feet, setFeet] = useState(500);
  const [customFeet, setCustomFeet] = useState('');
  const [everywhere, setEverywhere] = useState(true);
  const [busy, setBusy] = useState<'find' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then(setTiles);
    // Start on the user's own position if we have it (no new GPS fix needed).
    Location.getLastKnownPositionAsync()
      .then((l) => {
        if (!l) return;
        const p = { lat: l.coords.latitude, lng: l.coords.longitude };
        setFocus({ ...p, zoom: 16, key: Date.now() });
      })
      .catch(() => {});
  }, []);

  const place = async (p: { lat: number; lng: number }, label?: string | null) => {
    setPoint(p);
    setFocus({ ...p, zoom: 17, key: Date.now() });
    if (label !== undefined) return setAddress(label);
    // Show which address a tapped point is, when the phone can tell.
    const found = await Location.reverseGeocodeAsync({ latitude: p.lat, longitude: p.lng }).catch(() => []);
    setAddress(formatAddress(found[0]));
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

  const radiusFeet = customFeet ? Number(customFeet) : feet;
  const radiusOk = Number.isFinite(radiusFeet) && radiusFeet >= MIN_FT && radiusFeet <= MAX_FT;

  const save = async () => {
    if (!point || !radiusOk) return;
    setBusy('save');
    setError(null);
    try {
      // One place can be shared with every circle: each gets its own encrypted
      // copy, linked by a group id so the phone watches it once.
      const targets = everywhere ? circles : [getClient()];
      const group = randomId(9);
      const radius = Math.round(feetToMeters(radiusFeet));
      const results = await Promise.allSettled(
        targets.map((c) => c.savePlace({ name, lat: point.lat, lng: point.lng, radius, address, group })),
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
            style={[input, { width: 120 }]}
          />
          <Text style={{ color: t.muted, fontSize: 16 }}>feet</Text>
        </View>
        {!radiusOk ? (
          <Text style={{ color: t.danger, fontSize: 14 }}>Use between {MIN_FT} and {MAX_FT.toLocaleString()} feet.</Text>
        ) : (
          <Text style={{ color: t.muted, fontSize: 13 }}>500 ft or more: phones can’t reliably detect smaller areas, so arrivals would be missed.</Text>
        )}

        {circles.length > 1 ? (
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

        <Button title="Save place" variant="primary" loading={busy === 'save'} disabled={!point || !name.trim() || !radiusOk} onPress={save} style={{ marginTop: 6 }} />
        <ErrorText>{error}</ErrorText>
        <Text style={{ color: t.muted, fontSize: 13 }}>
          The address is looked up by your phone’s map service. Places are stored end-to-end encrypted, so your HomeCircle server never learns where they are.
        </Text>
      </ScrollView>
    </View>
  );
}
