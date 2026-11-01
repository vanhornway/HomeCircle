import { useEffect, useState } from 'react';
import { Animated, PanResponder, Pressable, Text, View } from 'react-native';
import type { CircleClient } from '@homecircle/core';
import { usePlaceName } from '../lib/weather';
import { useTileView } from '../lib/pluginTile';
import { useTheme } from '../theme';
import { AirFace } from './AirTile';
import { PrayerFace } from './PrayerTile';
import { WeatherFace } from './WeatherTile';

// Three sizes, stepped by a tap: a circle with just the plugin's icon
// (the default, so the map is free), the small tile, and the big one with the
// next hours; then back to the circle.
const CIRCLE = { scale: 0.8, width: 48, height: 48 };
const SMALL = { scale: 0.8, width: 140, height: 142 };
const BIG = { scale: 1.1, width: 290, height: 336 };
// The card lets the map show through (#RRGGBB + alpha).
const see = (hex: string) => `${hex}B8`;
const SWIPE_PX = 36;

const FACES = [
  { id: 'weather', name: 'Weather', glyph: '🌤️', Face: WeatherFace },
  { id: 'air', name: 'Air and pollen', glyph: '🌿', Face: AirFace },
  { id: 'prayer', name: 'Prayer times', glyph: '🕌', Face: PrayerFace },
] as const;

// Which tile you left it at, while the app is open (the size is kept across restarts).
const kept = { index: 0 };
const keep = (index: number) => Object.assign(kept, { index });

/** Sideways swipes between tiles (made once per card; it's told how many tiles and how wide). */
class Swipe {
  x = new Animated.Value(0);
  private count = 0;
  private width = 0;
  constructor(private turn: (dir: 1 | -1, count: number) => void) {}
  pan = PanResponder.create({
    // Sideways only, so taps and the map's own drags are left alone.
    onMoveShouldSetPanResponderCapture: (_, g) => this.count > 1 && Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderMove: (_, g) => this.x.setValue(g.dx),
    onPanResponderRelease: (_, g) => {
      if (g.dx < -SWIPE_PX || g.vx < -0.5) this.step(1);
      else if (g.dx > SWIPE_PX || g.vx > 0.5) this.step(-1);
      else this.back();
    },
    onPanResponderTerminate: () => this.back(),
  });
  size(count: number, width: number) {
    this.count = count;
    this.width = width;
  }
  /** The tile slides out one side, the next one in from the other. */
  step(dir: 1 | -1) {
    if (this.count < 2) return;
    Animated.timing(this.x, { toValue: -dir * this.width, duration: 140, useNativeDriver: false }).start(() => {
      this.turn(dir, this.count);
      this.x.setValue(dir * this.width);
      Animated.timing(this.x, { toValue: 0, duration: 170, useNativeDriver: false }).start();
    });
  }
  back() {
    Animated.spring(this.x, { toValue: 0, useNativeDriver: false }).start();
  }
}

/**
 * The plugins' tiles in the map's top-right corner, for the selected person
 * (or you): weather, air and pollen, prayer times, one at a time in the same
 * card. Swipe for the next one, in any size; dots show there are more. A tap steps the size: a
 * circle with just the plugin's icon, the small tile, the big tile, and back
 * to the circle. The size is remembered on the phone.
 */
export function PluginTiles({ client, memberId }: { client: CircleClient; memberId: string | null }) {
  const t = useTheme();
  const faces = FACES.filter((f) => client.feature(f.id));
  const [index, setIndex] = useState(kept.index);
  const [view, stepView] = useTileView();
  const big = view === 'big';
  const [swipe] = useState(() => new Swipe((dir, count) => setIndex((i) => (i + dir + count) % count)));
  const me = client.account?.memberId ?? null;
  const id = memberId ?? me;
  const loc = id ? client.locations.get(id) : undefined;
  const who = id && id !== me ? client.members.get(id)?.name : null;
  const place = usePlaceName(client, loc);
  const size = view === 'circle' ? CIRCLE : big ? BIG : SMALL;
  useEffect(() => swipe.size(faces.length, size.width), [swipe, faces.length, size.width]);
  useEffect(() => {
    keep(index);
  }, [index]);

  if (!faces.length || !loc) return null;
  const at = Math.min(index, faces.length - 1);
  const { Face, name } = faces[at];
  const z = (n: number) => Math.round(n * size.scale);
  const title = [who, place].filter(Boolean).join(' · ') || name;
  const toggle = stepView;
  const turn = (dir: 1 | -1) => setIndex((i) => (i + dir + faces.length) % faces.length);
  const next = view === 'circle' ? 'show the small tile' : view === 'small' ? 'show more' : 'shrink it to an icon';
  const glyph = faces[at].glyph;

  return (
    <View
      {...swipe.pan.panHandlers}
      style={{ width: size.width, height: size.height, borderRadius: view === 'circle' ? size.width / 2 : z(22), overflow: 'hidden', backgroundColor: see(t.surface), borderWidth: 1, borderColor: see(t.line) }}
    >
      <Pressable
        accessibilityRole="adjustable"
        accessibilityLabel={view === 'circle' ? `${name}` : undefined}
        accessibilityState={{ expanded: view !== 'circle' }}
        accessibilityHint={`Tap to ${next}.${faces.length > 1 ? ' Swipe up or down for the next tile.' : ''}`}
        accessibilityActions={[{ name: 'activate' }, { name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'activate') toggle();
          else turn(e.nativeEvent.actionName === 'increment' ? 1 : -1);
        }}
        onPress={toggle}
        style={{ flex: 1 }}
      >
        {view === 'circle' ? (
          // Just the plugin's icon; a swipe still brings the next one in.
          <Animated.View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', transform: [{ translateX: swipe.x }] }}>
            <Text style={{ fontSize: 24 }}>{glyph}</Text>
          </Animated.View>
        ) : (
          <Animated.View style={{ flex: 1, padding: z(8), paddingBottom: faces.length > 1 ? z(8) + 8 : z(8), transform: [{ translateX: swipe.x }] }}>
            <Face client={client} loc={loc} title={title} big={big} z={z} />
          </Animated.View>
        )}
        {faces.length > 1 ? (
          <View pointerEvents="none" style={{ position: 'absolute', bottom: view === 'circle' ? 4 : 5, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: view === 'circle' ? 3 : 5 }}>
            {faces.map((f, i) => (
              <View key={f.id} style={{ width: view === 'circle' ? 4 : 5, height: view === 'circle' ? 4 : 5, borderRadius: 3, backgroundColor: i === at ? t.text : t.muted, opacity: i === at ? 0.9 : 0.4 }} />
            ))}
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}
