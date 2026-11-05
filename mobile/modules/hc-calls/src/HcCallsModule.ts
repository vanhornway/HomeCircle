// Android-only helpers for voice calls (see android/.../HcCallsModule.kt):
// audio mode and routing, the call foreground service, ringing, the
// incoming-call notification. Everything degrades quietly where the native
// module isn't there (iOS, an older build, Expo Go).
import { requireOptionalNativeModule } from 'expo';

export type AudioRoute = 'earpiece' | 'speaker' | 'bluetooth';
export type Routes = { available: AudioRoute[]; current: AudioRoute };
/** The button pressed on the incoming-call notification (or 'open': the notification itself). */
export type EndTone = 'busy' | 'declined' | 'failed';
export type LaunchAction = { action: 'answer' | 'decline' | 'open'; callId: string; circleId: string; peerId: string };

type Native = {
  startService(title: string, text: string): boolean;
  stopService(): void;
  setCallAudio(active: boolean): void;
  setRoute(route: AudioRoute): boolean;
  getRoutes(): Routes;
  startRinging(): void;
  stopRinging(): void;
  startRingback(loud: boolean): void;
  stopRingback(): void;
  playEndTone(kind: EndTone): void;
  buzz(): void;
  showIncoming(callId: string, name: string, circleId: string, peerId: string): void;
  cancelIncoming(): void;
  showMissed(name: string): void;
  consumeLaunchAction(): LaunchAction | null;
  showOverLockScreen(on: boolean): void;
  canUseFullScreenIntent(): boolean;
  openFullScreenSettings(): boolean;
  addListener(event: 'onRoutesChanged' | 'onCallAction', fn: (e: any) => void): { remove(): void };
};

const native = requireOptionalNativeModule<Native>('HcCalls');

const quiet = <T>(fn: () => T, fallback: T): T => {
  try {
    return native ? fn() : fallback;
  } catch {
    return fallback;
  }
};

/** Whether this build has the call helpers (an Android build made with them). */
export const hasCallHelpers = () => !!native;

/** Keep the call alive in the background: foreground service, wake lock, Wi-Fi lock. */
export const startCallService = (title: string, text: string) => quiet(() => native!.startService(title, text), false);
export const stopCallService = () => quiet(() => native!.stopService(), undefined);
/** The call audio mode and focus (on at the start of a call, off at its end). */
export const setCallAudio = (active: boolean) => quiet(() => native!.setCallAudio(active), undefined);
export const setAudioRoute = (route: AudioRoute) => quiet(() => native!.setRoute(route), false);
export const getAudioRoutes = (): Routes => quiet(() => native!.getRoutes(), { available: ['earpiece', 'speaker'], current: 'earpiece' });
export const startRinging = () => quiet(() => native!.startRinging(), undefined);
export const stopRinging = () => quiet(() => native!.stopRinging(), undefined);
/** What the caller hears: soft while the call goes out, full once the other phone rings. */
export const startRingback = (loud: boolean) => quiet(() => native!.startRingback(loud), undefined);
export const stopRingback = () => quiet(() => native!.stopRingback(), undefined);
export const playEndTone = (kind: EndTone) => quiet(() => native!.playEndTone(kind), undefined);
export const buzz = () => quiet(() => native!.buzz(), undefined);
export const showIncomingCall = (callId: string, name: string, circleId: string, peerId: string) => quiet(() => native!.showIncoming(callId, name, circleId, peerId), undefined);
export const cancelIncomingCall = () => quiet(() => native!.cancelIncoming(), undefined);
export const showMissedCall = (name: string) => quiet(() => native!.showMissed(name), undefined);
export const consumeLaunchAction = (): LaunchAction | null => quiet(() => native!.consumeLaunchAction(), null);
export const showOverLockScreen = (on: boolean) => quiet(() => native!.showOverLockScreen(on), undefined);
export const canUseFullScreenIntent = () => quiet(() => native!.canUseFullScreenIntent(), true);
export const openFullScreenSettings = () => quiet(() => native!.openFullScreenSettings(), false);

export function onRoutesChanged(fn: (r: Routes) => void): () => void {
  const sub = quiet(() => native!.addListener('onRoutesChanged', fn), null);
  return () => sub?.remove();
}
export function onCallAction(fn: (a: LaunchAction) => void): () => void {
  const sub = quiet(() => native!.addListener('onCallAction', fn), null);
  return () => sub?.remove();
}
