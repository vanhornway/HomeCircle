import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import * as Location from 'expo-location';
import { FamilyMap } from '../map/FamilyMap';
import { Button, ErrorText } from '../components/ui';
import { errorText, getClient } from '../lib/circle';
import { DEFAULT_SETTINGS, getSettings } from '../lib/storage';
import { useTheme } from '../theme';

const RADII = [100, 150, 250, 500, 1000];

export default function AddPlace() {
  const t = useTheme();
  const [tiles, setTiles] = useState(DEFAULT_SETTINGS);
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [focus, setFocus] = useState<{ lat: number; lng: number; zoom: number; key: number } | null>(null);
  const [name, setName] = useState('');
  const [radius, setRadius] = useState(150);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then(setTiles);
    // Start on the user's own position if we have it (no new GPS fix needed).
    Location.getLastKnownPositionAsync()
      .then((l) => {
        if (!l) return;
        const p = { lat: l.coords.latitude, lng: l.coords.longitude };
        setPoint(p);
        setFocus({ ...p, zoom: 16, key: Date.now() });
      })
      .catch(() => {});
  }, []);

  const save = async () => {
    if (!point) return;
    setBusy(true);
    setError(null);
    try {
      await getClient().savePlace({ name, lat: point.lat, lng: point.lng, radius });
      router.back();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ flex: 1 }}>
        <FamilyMap
          tileUrl={tiles.tileUrl}
          attribution={tiles.tileAttribution}
          pickMode
          picked={point ? { ...point, radius } : null}
          onPick={setPoint}
          focus={focus}
          dark={t.dark}
        />
      </View>
      <View style={{ padding: 16, gap: 12, backgroundColor: t.surface }}>
        <Text style={{ color: t.muted }}>{point ? 'Tap the map to move the place.' : 'Tap the map to drop the place.'}</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Name (Home, School, Work…)"
          placeholderTextColor={t.muted}
          maxLength={40}
          style={{ backgroundColor: t.bg, borderRadius: 12, borderWidth: 1, borderColor: t.line, paddingHorizontal: 14, minHeight: 48, fontSize: 16, color: t.text }}
        />
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {RADII.map((r) => (
            <Pressable
              key={r}
              onPress={() => setRadius(r)}
              style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: r === radius ? t.brand : t.line, backgroundColor: r === radius ? t.brandSoft : 'transparent' }}
            >
              <Text style={{ color: r === radius ? t.brand : t.text, fontWeight: '600' }}>{r} m</Text>
            </Pressable>
          ))}
        </View>
        <Button title="Save place" variant="primary" loading={busy} disabled={!point || !name.trim()} onPress={save} />
        <ErrorText>{error}</ErrorText>
      </View>
    </View>
  );
}
