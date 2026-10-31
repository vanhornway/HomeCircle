// Which size the plugin tile on the map is, kept on this phone across
// restarts (a circle until the person opens it).
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { nextTileView, parseTileView, type TileView } from './pluginTileState';

const KEY = 'homecircle.pluginTileView';
let current: TileView = 'circle';
let loaded = false;
const listeners = new Set<() => void>();

function set(v: TileView) {
  if (v === current) return;
  current = v;
  listeners.forEach((l) => l());
}

/** Load the saved size once (the circle shows until it's read, which takes a moment). */
function load() {
  if (loaded) return;
  loaded = true;
  AsyncStorage.getItem(KEY)
    .then((raw) => set(parseTileView(raw)))
    .catch(() => {});
}

export function setTileView(v: TileView) {
  set(v);
  AsyncStorage.setItem(KEY, v).catch(() => {});
}

/** The tile's size, and a way to step it on (circle → small → big → circle). */
export function useTileView(): [TileView, () => void] {
  const view = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      load();
      return () => listeners.delete(l);
    },
    () => current,
  );
  return [view, () => setTileView(nextTileView(current))];
}
