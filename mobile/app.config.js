// HomeCircle, with every skin built in (src/skins): one app, one APK.
//
// APP_VARIANT=companion is the door to a separate store listing for the
// Elderly Companion skin (its own app id, name and icon), not used today.
/* global __dirname */
const fs = require('fs');
const path = require('path');

const COMPANION_ID = 'us.umair.homecircle.companion';

/** Whether google-services.json has a Firebase client for this package (push needs one). */
function hasFirebaseClient(file, pkg) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
    return json.client.some((c) => c.client_info?.android_client_info?.package_name === pkg);
  } catch {
    return false;
  }
}

module.exports = ({ config }) => {
  const variant = process.env.APP_VARIANT === 'companion' ? 'companion' : 'homecircle';
  config.extra = { ...config.extra, variant };

  // The phrase recordings (every skin's spoken lines) play from res/raw,
  // where expo-notifications puts its sounds. Every build has them.
  const recordings = fs
    .readdirSync(path.join(__dirname, 'assets/phrases'))
    .filter((f) => /^[a-z]{2}_[a-z0-9_]+\.wav$/.test(f))
    .map((f) => `./assets/phrases/${f}`);
  config.plugins = config.plugins.map((p) => (Array.isArray(p) && p[0] === 'expo-notifications' ? [p[0], { ...p[1], sounds: [...p[1].sounds, ...recordings] }] : p));
  if (variant !== 'companion') return config;

  // A separate store listing for the Elderly Companion skin: not built now,
  // kept so it can be. The phone then always shows that skin.
  const android = { ...config.android, package: COMPANION_ID, adaptiveIcon: { ...config.android.adaptiveIcon, backgroundColor: '#1F7A4D' } };
  // Without a Firebase client for this package the build would fail; it then
  // runs without push (live updates still arrive while it's open).
  if (!hasFirebaseClient(config.android.googleServicesFile, COMPANION_ID)) delete android.googleServicesFile;

  return {
    ...config,
    name: 'Elderly Companion',
    scheme: 'homecircle-companion',
    ios: { ...config.ios, bundleIdentifier: COMPANION_ID },
    android,
  };
};
