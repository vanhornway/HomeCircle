// Android-only helpers for chirps (see android/.../HcAttentionModule.kt).
// Everything degrades quietly where the native module isn't there.
import { requireOptionalNativeModule } from 'expo';

type Native = {
  isDoNotDisturbOn(): boolean;
  blink(times: number, onMs: number, offMs: number): Promise<boolean>;
  preview(name: string): boolean;
};

const native = requireOptionalNativeModule<Native>('HcAttention');

/** Whether Do Not Disturb is limiting alerts right now (false if unknown). */
export function isDoNotDisturbOn(): boolean {
  try {
    return native?.isDoNotDisturbOn() ?? false;
  } catch {
    return false;
  }
}

/** Blink the camera light a few times. Resolves false if it couldn't. */
export async function blinkLight(times = 3, onMs = 180, offMs = 160): Promise<boolean> {
  try {
    return (await native?.blink(times, onMs, offMs)) ?? false;
  } catch {
    return false;
  }
}

/** Play one of the bundled sounds once, e.g. 'chirp_robin'. */
export function previewSound(name: string): boolean {
  try {
    return native?.preview(name) ?? false;
  } catch {
    return false;
  }
}
