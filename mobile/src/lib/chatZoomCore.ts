// Pinch to zoom the chat's text: the maths, kept apart from React Native so it
// can be tested.
//   node --experimental-strip-types --test src/lib/chatZoomCore.test.ts

export const MIN_CHAT_SCALE = 0.85;
export const MAX_CHAT_SCALE = 2;
/** The zoom steps the Settings buttons jump between. */
export const CHAT_SCALE_STEPS = [1, 1.25, 1.5, 2] as const;

/** Within the limits, on 5% steps (so a pinch redraws the chat a few times, not on every pixel). */
export function clampScale(s: number): number {
  if (!Number.isFinite(s)) return 1;
  return Math.min(MAX_CHAT_SCALE, Math.max(MIN_CHAT_SCALE, Math.round(s * 20) / 20));
}

export function touchDistance(touches: ArrayLike<{ pageX: number; pageY: number }>): number {
  if (touches.length < 2) return 0;
  return Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);
}

/** The zoom after the fingers moved from `startDist` apart to `dist` apart. */
export function pinchedScale(startScale: number, startDist: number, dist: number): number {
  if (!(startDist > 0) || !(dist > 0)) return clampScale(startScale);
  return clampScale(startScale * (dist / startDist));
}

/** A font size or line height at the chat's zoom. */
export const scaled = (n: number, scale: number) => Math.round(n * scale);

export const percentLabel = (scale: number) => `${Math.round(scale * 100)}%`;
