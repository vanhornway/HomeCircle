import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { CircleClient, PluginSettings } from '@homecircle/core';
import { errorText } from '../lib/circle';
import { slugName } from '../lib/plugins';
import { useTheme } from '../theme';
import { Button, ErrorText, Field } from './ui';

/**
 * A plugin's settings for this circle, under its switch in Settings →
 * Features (admins): Home Assistant's address and token, an optional key.
 * Secrets are never shown back, only that one is saved.
 */
export function PluginSetup({ client, id }: { client: CircleClient; id: string }) {
  const t = useTheme();
  const [info, setInfo] = useState<PluginSettings | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

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
    client.api
      .putPluginSettings(id, values)
      .then((r: { values: PluginSettings['values']; ready: boolean }) => {
        setInfo({ ...info, values: r.values, ready: r.ready });
        setValues((v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, info.fields.find((f) => f.id === k)?.secret ? '' : String(r.values[k] ?? x)])));
        setSaved(true);
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
            ? `${saved ? 'Connected. ' : 'Connected · '}Each person shows up in Home Assistant (Settings → Devices → Mobile App) once their phone next shares its location; open phones do it right away. Yours: device_tracker.homecircle_${slugName(me)}.`
            : (info.fields.some(isSet) ? 'Pollen comes from Google. ' : 'Pollen comes from Open-Meteo (Europe only). ') + (saved ? 'Saved.' : '')}
        </Text>
      ) : null}
    </View>
  );
}
