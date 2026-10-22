// Is this phone set up to share its location reliably? Used for the setup
// checklist, the "Setup needs attention" banner, and the status that travels
// with every location update (so the circle sees why updates may be late).
import { Linking, Platform } from 'react-native';
import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as IntentLauncher from 'expo-intent-launcher';
import Constants from 'expo-constants';

export type Health = {
  /** Battery saver / Low Power Mode. */
  power: 'saver' | 'normal';
  /** Location permission level. */
  perm: 'always' | 'foreground';
  /** Precise location allowed. */
  precise: boolean;
};

export async function phoneHealth(): Promise<Health> {
  const [saver, bg, fg] = await Promise.all([
    Battery.isLowPowerModeEnabledAsync().catch(() => false),
    Location.getBackgroundPermissionsAsync().catch(() => null),
    Location.getForegroundPermissionsAsync().catch(() => null),
  ]);
  const precise = Platform.OS === 'ios' ? fg?.ios?.accuracy !== 'reduced' : fg?.android?.accuracy !== 'coarse';
  return { power: saver ? 'saver' : 'normal', perm: bg?.status === 'granted' ? 'always' : 'foreground', precise };
}

export type CheckItem = {
  id: string;
  title: string;
  /** One line on why it matters. */
  why: string;
  ok: boolean;
  /** Not every check can be read on every phone. */
  unknown?: boolean;
  fixLabel: string;
  fix: () => Promise<unknown>;
};

const openAppSettings = () => Linking.openSettings();
const packageName = () => Constants.expoConfig?.android?.package ?? 'us.umair.homecircle';

/** The setup checklist for this phone, with a one-tap fix for each item. */
export async function setupChecklist(): Promise<CheckItem[]> {
  const [fg, bg, notif, optimized, bgTask, saver] = await Promise.all([
    Location.getForegroundPermissionsAsync().catch(() => null),
    Location.getBackgroundPermissionsAsync().catch(() => null),
    Notifications.getPermissionsAsync().catch(() => null),
    Platform.OS === 'android' ? Battery.isBatteryOptimizationEnabledAsync().catch(() => null) : Promise.resolve(null),
    BackgroundTask.getStatusAsync().catch(() => null),
    Battery.isLowPowerModeEnabledAsync().catch(() => false),
  ]);
  const always = bg?.status === 'granted';
  const precise = Platform.OS === 'ios' ? fg?.ios?.accuracy !== 'reduced' : fg?.android?.accuracy !== 'coarse';
  const items: CheckItem[] = [
    {
      id: 'location',
      title: Platform.OS === 'ios' ? 'Location: Always' : 'Location: Allow all the time',
      why: 'Without it, your circle only sees where you were the last time you opened the app.',
      ok: always,
      fixLabel: fg?.status !== 'granted' ? 'Allow' : 'Open settings',
      fix: async () => {
        if (fg?.status !== 'granted') {
          const r = await Location.requestForegroundPermissionsAsync();
          if (r.status !== 'granted') return openAppSettings();
        }
        const r2 = await Location.requestBackgroundPermissionsAsync().catch(() => null);
        if (r2?.status !== 'granted') return openAppSettings();
      },
    },
    {
      id: 'precise',
      title: 'Precise location',
      why: 'Approximate location is too rough to tell when someone arrives home.',
      ok: precise,
      fixLabel: 'Open settings',
      fix: openAppSettings,
    },
    {
      id: 'notifications',
      title: 'Notifications',
      why: 'So you hear about messages, arrivals and check-ins.',
      ok: !!notif?.granted,
      fixLabel: notif?.canAskAgain === false ? 'Open settings' : 'Allow',
      fix: async () => {
        if (notif?.canAskAgain === false) return openAppSettings();
        const r = await Notifications.requestPermissionsAsync();
        if (!r.granted) return openAppSettings();
      },
    },
  ];
  if (Platform.OS === 'android') {
    items.push(
      {
        id: 'battery',
        title: 'Battery: Unrestricted',
        why: 'Battery optimization can stop updates when the phone sits still for a while.',
        ok: optimized === false,
        unknown: optimized == null,
        fixLabel: 'Allow',
        fix: async () => {
          // Asks directly for the exemption; falls back to the list of apps.
          try {
            await IntentLauncher.startActivityAsync('android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', { data: `package:${packageName()}` });
          } catch {
            await IntentLauncher.startActivityAsync('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS').catch(openAppSettings);
          }
        },
      },
      {
        id: 'unused',
        title: '“Pause app activity if unused”: off',
        why: 'Otherwise Android may remove HomeCircle’s permissions after a few months without opening it.',
        ok: true,
        unknown: true,
        fixLabel: 'Open settings',
        fix: openAppSettings,
      },
    );
  } else {
    items.push({
      id: 'refresh',
      title: 'Background App Refresh',
      why: 'Lets iPhone send a regular “still here” update when you’re not moving.',
      ok: bgTask === BackgroundTask.BackgroundTaskStatus.Available,
      unknown: bgTask == null,
      fixLabel: 'Open settings',
      fix: openAppSettings,
    });
  }
  items.push({
    id: 'saver',
    title: Platform.OS === 'ios' ? 'Low Power Mode: off' : 'Battery saver: off',
    why: 'Battery saver slows down location updates. Your circle sees when it’s on.',
    ok: !saver,
    fixLabel: 'Open settings',
    fix: () =>
      Platform.OS === 'android'
        ? IntentLauncher.startActivityAsync('android.settings.BATTERY_SAVER_SETTINGS').catch(openAppSettings)
        : openAppSettings(),
  });
  return items;
}

/** Items that need fixing (battery saver is informational, not a setup problem). */
export const needsAttention = (items: CheckItem[]) => items.filter((i) => !i.ok && !i.unknown && i.id !== 'saver');

/** Extra steps some phone makers need, shown under the checklist. */
export function makerTips(): { maker: string; steps: string } | null {
  if (Platform.OS !== 'android') return null;
  const brand = (Constants.deviceName || '').toLowerCase() + ' ' + String((Platform.constants as { Brand?: string; Manufacturer?: string }).Manufacturer || '').toLowerCase();
  if (brand.includes('samsung'))
    return { maker: 'Samsung', steps: 'Settings → Battery → Background usage limits → Never sleeping apps → add HomeCircle.' };
  if (brand.includes('xiaomi') || brand.includes('redmi') || brand.includes('poco'))
    return { maker: 'Xiaomi', steps: 'Settings → Apps → HomeCircle → Autostart on, and Battery saver → No restrictions.' };
  if (brand.includes('oneplus') || brand.includes('oppo') || brand.includes('realme'))
    return { maker: 'OnePlus / OPPO', steps: 'Settings → Battery → HomeCircle → Allow background activity, and turn off “Optimize battery use”.' };
  if (brand.includes('huawei') || brand.includes('honor'))
    return { maker: 'Huawei / Honor', steps: 'Settings → Battery → App launch → HomeCircle → Manage manually, with all three switches on.' };
  return null;
}
