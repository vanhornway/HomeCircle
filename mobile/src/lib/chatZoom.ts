// Chat text size on this phone: pinch the chat to zoom its text, remembered
// until you change it. It multiplies the phone's own font size setting, which
// Text already follows, so large system text stays large.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { PanResponder } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { clampScale, pinchedScale, scaled, touchDistance } from './chatZoomCore';

const KEY = 'homecircle.chatTextScale';

let scale = 1;
let loaded = false;
const subs = new Set<() => void>();

function load() {
  if (loaded) return;
  loaded = true;
  AsyncStorage.getItem(KEY)
    .then((raw) => {
      if (raw != null) setChatScale(Number(raw), false);
    })
    .catch(() => {});
}

export const getChatScale = () => scale;

/** Set the zoom; `save` false while fingers are still moving. */
export function setChatScale(next: number, save = true) {
  const v = clampScale(next);
  if (v !== scale) {
    scale = v;
    subs.forEach((fn) => fn());
  }
  if (save) AsyncStorage.setItem(KEY, String(v)).catch(() => {});
}

/** The chat's text zoom (1 = normal), re-rendering when it changes. */
export function useChatScale(): number {
  load();
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    getChatScale,
  );
}

/** `fs(17)`: a font size or line height at the chat's zoom. */
export function useChatFont(): (n: number) => number {
  const z = useChatScale();
  return (n) => scaled(n, z);
}

/** One pinch at a time: where the fingers started, and the zoom they started at. */
class Pinch {
  private start: { dist: number; scale: number } | null = null;
  private hide: ReturnType<typeof setTimeout> | null = null;
  constructor(private set: (state: { pinching: boolean; showing: boolean }) => void) {}
  private end = () => {
    if (!this.start) return;
    this.start = null;
    setChatScale(getChatScale());
    this.set({ pinching: false, showing: true });
    if (this.hide) clearTimeout(this.hide);
    this.hide = setTimeout(() => this.set({ pinching: false, showing: false }), 3500);
  };
  pan = PanResponder.create({
    // A second finger down takes over from whatever the first one was doing.
    onStartShouldSetPanResponderCapture: (e) => e.nativeEvent.touches.length >= 2,
    onMoveShouldSetPanResponderCapture: (e) => e.nativeEvent.touches.length >= 2,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      this.start = { dist: touchDistance(e.nativeEvent.touches), scale: getChatScale() };
      if (this.hide) clearTimeout(this.hide);
      this.set({ pinching: true, showing: true });
    },
    onPanResponderMove: (e) => {
      const s = this.start;
      const touches = e.nativeEvent.touches;
      if (!s || touches.length < 2) return;
      // A baseline from the first move with two fingers down.
      if (!(s.dist > 0)) s.dist = touchDistance(touches);
      else setChatScale(pinchedScale(s.scale, s.dist, touchDistance(touches)), false);
    },
    onPanResponderRelease: this.end,
    onPanResponderTerminate: this.end,
  });
  dispose() {
    if (this.hide) clearTimeout(this.hide);
  }
}

/**
 * Two-finger pinch on a view's children (spread `panHandlers` on it). One
 * finger is left alone (scrolling, taps, long-presses); a second finger down
 * takes over, so the list doesn't scroll while you zoom. `showing` stays true
 * for a few seconds after, for the "Text size" chip with its Reset button.
 */
export function usePinchZoom() {
  const [state, setState] = useState({ pinching: false, showing: false });
  const [pinch] = useState(() => new Pinch(setState));
  useEffect(() => () => pinch.dispose(), [pinch]);
  return { panHandlers: pinch.pan.panHandlers, ...state };
}
