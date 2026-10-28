// Two apps from one project: HomeCircle, and with APP_VARIANT=companion the
// Elderly Companion app (big photo tiles, call-back requests, SOS and games
// for an elderly family member). Both share every screen-independent part:
// background location, push, SOS, the native module and packages/core.
//
//   npx expo run:android                              HomeCircle
//   APP_VARIANT=companion npx expo prebuild --clean   then build: Elderly Companion
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
  if (variant !== 'companion') return config;

  // The Urdu clips play from res/raw, where expo-notifications puts its sounds.
  const clips = fs
    .readdirSync(path.join(__dirname, 'assets/clips'))
    .filter((f) => /^ur_[a-z0-9_]+\.wav$/.test(f))
    .map((f) => `./assets/clips/${f}`);
  const plugins = config.plugins.map((p) => (Array.isArray(p) && p[0] === 'expo-notifications' ? [p[0], { ...p[1], sounds: [...p[1].sounds, ...clips] }] : p));

  const android = { ...config.android, package: COMPANION_ID, adaptiveIcon: { ...config.android.adaptiveIcon, backgroundColor: '#1F7A4D' } };
  // Without a Firebase client for this package the build would fail; it then
  // runs without push (live updates still arrive while it's open).
  if (!hasFirebaseClient(config.android.googleServicesFile, COMPANION_ID)) delete android.googleServicesFile;

  return {
    ...config,
    name: 'Elderly Companion',
    scheme: 'homecircle-companion',
    // Big tiles are easier to read in a light theme; it doesn't follow the phone.
    userInterfaceStyle: 'light',
    ios: { ...config.ios, bundleIdentifier: COMPANION_ID },
    android,
    plugins,
  };
};
