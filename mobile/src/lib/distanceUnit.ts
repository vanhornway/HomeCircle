// Miles or kilometres for tracker distances (how far it is, how far a journey
// went), chosen on this phone: Settings → Display, or tap a distance. Miles
// until changed.
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDistanceUnit, setUnitValue, type DistanceUnit } from './units';

const KEY = 'homecircle.distanceUnit';
const subs = new Set<() => void>();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  AsyncStorage.getItem(KEY)
    .then((v) => {
      if (v === 'km' || v === 'mi') setDistanceUnit(v, false);
    })
    .catch(() => {});
}
load();

export function setDistanceUnit(u: DistanceUnit, save = true) {
  if (u !== getDistanceUnit()) {
    setUnitValue(u);
    subs.forEach((fn) => fn());
  }
  if (save) AsyncStorage.setItem(KEY, u).catch(() => {});
}

export const toggleDistanceUnit = () => setDistanceUnit(getDistanceUnit() === 'mi' ? 'km' : 'mi');

/** The unit, re-rendering when it changes. */
export function useDistanceUnit(): DistanceUnit {
  load();
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    getDistanceUnit,
  );
}
