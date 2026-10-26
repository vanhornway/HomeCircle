// Home Assistant: each person's location in the circle's Home Assistant, to
// start automations ("when Maya gets home…"). An admin gives this circle the
// Home Assistant address and a long-lived access token. Each person then
// shows up there as a device of the Mobile App integration (as the Companion
// app does): a device_tracker that Home Assistant puts in its zones itself,
// and a battery sensor.
//
// Locations stay end-to-end encrypted for the circle, so the server can't
// read them; each phone also sends its position here (unless that person
// turned it off), and it goes straight on to Home Assistant. Nothing about
// where anyone is, is kept here: only the token and each person's device
// registration (a webhook id).
import { fail } from '../http.js';

const APP_ID = 'homecircle';
const clean = (s) =>
  String(s || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 40);

/** Checks an address and token: Home Assistant answers its API with them. */
async function check(reach, url, token) {
  let base;
  try {
    base = new URL(url);
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error();
  } catch {
    fail(400, 'invalid', 'The address should look like http://homeassistant.local:8123');
  }
  let res;
  try {
    res = await reach(base.origin)(`${base.origin}/api/`, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    fail(400, 'unreachable', `This server couldn’t reach ${base.host} (${e.message}). Use an address this server can reach.`);
  }
  if (res.status === 401 || res.status === 403) fail(400, 'invalid', 'Home Assistant didn’t accept that token. Make a long-lived access token on your Home Assistant profile page.');
  if (!res.ok) fail(400, 'invalid', `${base.host} answered ${res.status}. Is that your Home Assistant address?`);
  return base.origin;
}

export const homeAssistant = {
  id: 'homeAssistant',
  feature: 'homeAssistant',
  name: 'Home Assistant',
  hosts: [],
  settings: [
    { id: 'url', label: 'Home Assistant address', placeholder: 'http://homeassistant.local:8123', help: 'An address this HomeCircle server can reach.' },
    { id: 'token', label: 'Long-lived access token', secret: true, help: 'In Home Assistant: your profile → Security → Long-lived access tokens → Create token.' },
  ],
  // Running as the Home Assistant app (add-on), Home Assistant is right next door.
  suggest: (env) => (env.HOMECIRCLE_ADDON || env.SUPERVISOR_TOKEN ? { url: 'http://homeassistant:8123' } : {}),
  configure: async (values, { reach, old }) => {
    const url = await check(reach, values.url, values.token);
    // A different Home Assistant: everyone registers there afresh.
    return { url, token: values.token, devices: url === old.url ? (old.devices ?? {}) : {} };
  },
  routes: [
    {
      // A phone's position, for its person's device in Home Assistant.
      method: 'POST',
      path: '/location',
      handler: async ({ me, body, config, updateConfig, reach, version, log }) => {
        if (!config?.ready) fail(409, 'not_set_up', 'Home Assistant isn’t set up for this circle yet');
        const lat = Number(body?.lat);
        const lng = Number(body?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail(400, 'invalid', 'lat and lng must be a position');
        const name = clean(body.name) || 'Someone';
        const send = reach(config.url);
        const post = (path, payload, auth = false) => send(`${config.url}${path}`, { method: 'POST', body: payload, headers: auth ? { Authorization: `Bearer ${config.token}` } : {} });

        const register = async () => {
          const res = await post(
            '/api/mobile_app/registrations',
            {
              app_id: APP_ID,
              app_name: 'HomeCircle',
              app_version: String(version || '1'),
              device_name: `HomeCircle ${name}`,
              manufacturer: 'HomeCircle',
              model: 'Circle member',
              os_name: 'HomeCircle',
              os_version: String(version || '1'),
              device_id: `homecircle-${me.id}`,
              supports_encryption: false,
            },
            true,
          );
          if (res.status === 401 || res.status === 403) fail(502, 'ha_token', 'Home Assistant no longer accepts the token. An admin can enter a new one in Settings → Features.');
          if (res.status === 404) fail(502, 'ha_mobile_app', 'Home Assistant’s Mobile App integration isn’t loaded (it comes with default_config).');
          if (!res.ok || !res.json?.webhook_id) fail(502, 'ha_failed', `Home Assistant answered ${res.status}`);
          const device = { webhookId: res.json.webhook_id, name };
          // The battery, as a sensor on that device.
          await post(`/api/webhook/${device.webhookId}`, {
            type: 'register_sensor',
            data: { type: 'sensor', unique_id: 'battery_level', name: 'Battery level', device_class: 'battery', unit_of_measurement: '%', state_class: 'measurement', entity_category: 'diagnostic', icon: 'mdi:battery', state: 0 },
          });
          await post(`/api/webhook/${device.webhookId}`, {
            type: 'register_sensor',
            data: { type: 'binary_sensor', unique_id: 'charging', name: 'Charging', device_class: 'battery_charging', entity_category: 'diagnostic', icon: 'mdi:battery-charging', state: false },
          });
          // Read afresh: someone else may have registered meanwhile.
          updateConfig((cur) => ({ ...cur, devices: { ...cur?.devices, [me.id]: device } }));
          log('homeassistant: a person registered');
          return device;
        };

        const location = {
          type: 'update_location',
          data: {
            gps: [lat, lng],
            gps_accuracy: Math.max(0, Math.round(Number(body.accuracy) || 0)),
            ...(Number.isFinite(body.battery) ? { battery: Math.max(0, Math.min(100, Math.round(body.battery))) } : {}),
            ...(Number.isFinite(body.speed) && body.speed >= 0 ? { speed: Math.round(body.speed) } : {}),
          },
        };
        const update = async (device) => {
          const res = await post(`/api/webhook/${device.webhookId}`, location);
          if (res.status === 410 || res.status === 404) return false; // deleted in Home Assistant
          if (!res.ok) fail(502, 'ha_failed', `Home Assistant answered ${res.status}`);
          const sensors = [];
          if (Number.isFinite(body.battery)) sensors.push({ type: 'sensor', unique_id: 'battery_level', state: Math.round(body.battery), icon: 'mdi:battery' });
          if (typeof body.charging === 'boolean') sensors.push({ type: 'binary_sensor', unique_id: 'charging', state: body.charging, icon: 'mdi:battery-charging' });
          if (sensors.length) await post(`/api/webhook/${device.webhookId}`, { type: 'update_sensor_states', data: sensors });
          return true;
        };

        let device;
        try {
          device = config.devices?.[me.id] ?? (await register());
          // Removed in Home Assistant: register again, once.
          if (!(await update(device))) await update((device = await register()));
        } catch (e) {
          if (e.status) throw e;
          fail(502, 'ha_unreachable', `This server couldn’t reach Home Assistant (${e.message})`);
        }
        return { ok: true, entity: `device_tracker.${slug(`HomeCircle ${device.name}`)}` };
      },
    },
  ],
};

/** Home Assistant's entity id for a name ("HomeCircle Maya" → homecircle_maya). */
export const slug = (s) =>
  String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
