import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { CircleClient, PluginSettings } from '@homecircle/core';
import { errorText } from '../lib/circle';
import { sendToHomeAssistantNow } from '../lib/location';
import { slugName } from '../lib/plugins';
import { useTheme } from '../theme';
import { Button, ErrorText, Field } from './ui';

/**
 * A plugin's settings for this circle, under its switch in Settings →
 * Features (admins): Home Assistant's address and token, an optional key.
 * Secrets are never shown back, only that one is saved.
 */
// Spaces, line breaks and invisible characters that keyboards and copying slip
// into an address or a key (the server tidies them too).
const STRAY = /[\s\u00A0\u200B-\u200D\u2060\uFEFF]/g;
function tidyAll(fields: PluginSettings['fields'], values: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.id] ?? '';
    if (f.secret) out[f.id] = v.replace(STRAY, '');
    else if (f.id === 'url') {
      const u = v.replace(STRAY, '');
      out[f.id] = u && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? `https://${u}` : u;
    } else out[f.id] = v.trim();
  }
  return out;
}

export function PluginSetup({ client, id }: { client: CircleClient; id: string }) {
  const t = useTheme();
  const [info, setInfo] = useState<PluginSettings | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // After connecting Home Assistant: how sending yours went.
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    client.api
      .pluginSettings(id)
      .then((s: PluginSettings) => {
        if (!live) return;
        setInfo(s);
        const start: Record<string, string> = {};
        for (const f of s.fields) start[f.id] = f.secret ? '' : String(s.values[f.id] || s.suggested[f.id] || '');
        setValues(start);
      })
      .catch((e: Error) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [client, id]);

  if (!info)
    return error ? (
      <View style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
        <ErrorText>{error}</ErrorText>
      </View>
    ) : null;

  const isSet = (f: PluginSettings['fields'][number]) => typeof info.values[f.id] === 'object' && (info.values[f.id] as { set: boolean }).set;
  const missing = info.fields.some((f) => !f.optional && !values[f.id]?.trim() && !(f.secret && isSet(f)));
  const save = () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    setSent(null);
    client.api
      .putPluginSettings(id, tidyAll(info.fields, values))
      .then((r: { values: PluginSettings['values']; ready: boolean }) => {
        setInfo({ ...info, values: r.values, ready: r.ready });
        setValues((v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, info.fields.find((f) => f.id === k)?.secret ? '' : String(r.values[k] ?? x)])));
        setSaved(true);
        // Home Assistant: yours goes there now, so you can see it worked.
        if (id === 'homeAssistant') {
          setSent('Sending your location to Home Assistant…');
          sendToHomeAssistantNow(client)
            .then((r2) => setSent(r2.entity ? `Sent yours: it’s ${r2.entity} in Home Assistant.` : (r2.why ?? null)))
            .catch((e: Error) => setSent(`Couldn’t send yours yet: ${errorText(e)}`));
        }
      })
      .catch((e: Error) => setError(errorText(e)))
      .finally(() => setSaving(false));
  };
  const me = client.account?.profile.name ?? 'You';

  return (
    <View style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 4 }}>
      {info.fields.map((f) => (
        <View key={f.id}>
          <Field
            label={f.label}
            value={values[f.id] ?? ''}
            onChangeText={(v) => setValues((cur) => ({ ...cur, [f.id]: v }))}
            placeholder={f.secret && isSet(f) ? 'Saved · type a new one to replace it' : f.placeholder}
            secureTextEntry={!!f.secret}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            keyboardType={f.id === 'url' ? 'url' : 'default'}
            style={{ fontSize: 15, minHeight: 48 }}
          />
          {f.help ? (
            <Text
              style={{
                color: t.muted,
                fontSize: 13,
                lineHeight: 18,
                marginTop: -10,
                marginBottom: 12,
              }}
            >
              {f.help}
            </Text>
          ) : null}
        </View>
      ))}
      <ErrorText>{error}</ErrorText>
      <Button small variant="primary" title={info.ready ? 'Save' : id === 'homeAssistant' ? 'Connect' : 'Save'} loading={saving} disabled={missing} onPress={save} />
      {info.ready || id === 'air' ? (
        <Text style={{ color: t.muted, fontSize: 13, lineHeight: 18, marginTop: 6 }}>
          {id === 'homeAssistant'
            ? `${saved ? 'Connected. ' : 'Connected · '}${sent ? `${sent} ` : ''}Everyone else shows up in Home Assistant (Settings → Devices & services → Mobile App) once their phone, on HomeCircle 0.15 or newer, next shares its location. Yours: device_tracker.homecircle_${slugName(me)}.`
            : (info.fields.some(isSet) ? 'Pollen comes from Google. ' : 'Pollen comes from Open-Meteo (Europe only). ') + (saved ? 'Saved.' : '')}
        </Text>
      ) : null}
    </View>
  );
}
