// Tracker settings: how often Meshtastic trackers send their position and
// battery, and what pressing the button 1 to 5 times says. Without a member:
// every tracker's settings (the Meshtastic plugin's, on the server). With
// one: that tracker's own, kept in its member record (`tracker.custom`), or
// "same as every tracker", and what it's for (a person's, a car, a pet…)
// and who has it. The home base puts the intervals on the trackers
// over the radio and sends the messages for presses (devices/meshtastic).
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { TrackerCustom, TrackerMode } from '@homecircle/core';
import { Button, ErrorText, Field, P } from '../components/ui';
import { Pills } from '../components/Pills';
import { KeyHelp } from '../components/TrackerKeyHelp';
import { GroupBody, SettingsGroup, SettingsPage, ToggleRow } from '../components/SettingsKit';
import { errorText } from '../lib/circle';
import { notice } from '../lib/sheet';
import { homeBaseOf, PRESS_HELP, TRACKER_INTERVALS, TRACKER_KINDS, TRACKER_PRESSES, tellHomeBase, trackerOf } from '../lib/trackers';
import { useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

type Values = { moving: number; still: number; battery: number; presses: Record<number, string> };

const MOVING = [1, 2, 5, 10].map((v) => ({ value: v, label: `${v} min` }));
const STILL = [5, 15, 30, 60, 120].map((v) => ({ value: v, label: v < 60 ? `${v} min` : `${v / 60} h` }));
const BATTERY = [0, 15, 30, 60].map((v) => ({ value: v, label: v ? `${v} min` : 'Never' }));

/** A plugin value: its number, or the default when empty or not one of the choices. */
const num = (v: unknown, d: number) => {
  const n = Number(v);
  return typeof v === 'string' && v !== '' && Number.isInteger(n) ? n : d;
};
/** The pill nearest a value (a value set elsewhere may not be one of the choices). */
const nearest = (v: number, choices: { value: number }[]) => choices.reduce((a, b) => (Math.abs(b.value - v) < Math.abs(a.value - v) ? b : a)).value;

export default function TrackerSettings() {
  const t = useTheme();
  const client = useCircle(['members', 'records', 'status']);
  const { member } = useLocalSearchParams<{ member?: string }>();
  const tracker = member ? trackerOf(client, member) : null;
  const name = member ? (client.members.get(member)?.name ?? 'Tracker') : null;
  const home = homeBaseOf(client);
  const state = member && tracker ? home?.status.trackers.find((x) => x.node === tracker.node)?.settings : null;

  // The circle's settings (all of the plugin's values, so saving keeps the rest).
  const [plugin, setPlugin] = useState<Record<string, string> | null>(null);
  const [circle, setCircle] = useState<Values | null>(null);
  const [values, setValues] = useState<Values | null>(null);
  const [own, setOwn] = useState(false);
  // What it's for, and who has it (one person, for a tracker someone carries).
  const [mode, setMode] = useState<TrackerMode>(tracker?.mode ?? 'carried');
  const [carriedBy, setCarriedBy] = useState<string>(tracker?.carriedBy ?? '');
  const people = client.peopleList().filter((p) => p.kind !== 'agent');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Public: this tracker's beacon (minutes, 0 off), and the circle's public SOS.
  const [beacon, setBeacon] = useState<number>(tracker?.beacon ?? 0);
  const [publicSos, setPublicSos] = useState(false);

  useEffect(() => {
    if (!client.isAdmin) return;
    client.api
      .pluginSettings('meshtastic')
      .then((s) => {
        const raw: Record<string, string> = {};
        for (const f of s.fields) raw[f.id] = typeof s.values[f.id] === 'string' ? (s.values[f.id] as string) : '';
        const c: Values = {
          moving: num(raw.movingMinutes, TRACKER_INTERVALS.moving),
          still: num(raw.stillMinutes, TRACKER_INTERVALS.still),
          battery: num(raw.batteryMinutes, TRACKER_INTERVALS.battery),
          presses: Object.fromEntries(TRACKER_PRESSES.map((p) => [p.n, raw[`press${p.n}`] || p.text])),
        };
        setPlugin(raw);
        setCircle(c);
        setPublicSos(raw.publicSos === 'on');
        const custom = tracker?.custom ?? null;
        setOwn(!!custom);
        setValues({
          moving: custom?.moving ?? c.moving,
          still: custom?.still ?? c.still,
          battery: custom?.battery ?? c.battery,
          presses: Object.fromEntries(TRACKER_PRESSES.map((p) => [p.n, custom?.presses?.[String(p.n) as '1'] ?? c.presses[p.n]])),
        });
      })
      .catch((e) => setError(errorText(e)));
    // Load once; a save updates what's shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.isAdmin]);

  if (!client.isAdmin) {
    return (
      <SettingsPage title="Tracker settings">
        <SettingsGroup how={PRESS_HELP} howTitle="The tracker’s button">
          <GroupBody>
            <P muted>Only the circle’s admins change tracker settings.</P>
          </GroupBody>
        </SettingsGroup>
      </SettingsPage>
    );
  }
  if (member && !tracker) {
    return (
      <SettingsPage title="Tracker settings">
        <GroupBody>
          <P muted>That tracker isn’t in this circle any more.</P>
        </GroupBody>
      </SettingsPage>
    );
  }

  const editing = !member || own;
  const set = (patch: Partial<Values>) => setValues((v) => (v ? { ...v, ...patch } : v));

  const save = async () => {
    if (!values || !circle || !plugin) return;
    setSaving(true);
    setError(null);
    try {
      if (!member) {
        const text = (n: number) => {
          const v = values.presses[n]?.trim() ?? '';
          return v === TRACKER_PRESSES[n - 1].text ? '' : v; // the default stays empty, so a better default later applies
        };
        await client.api.putPluginSettings('meshtastic', {
          ...plugin,
          movingMinutes: values.moving === TRACKER_INTERVALS.moving ? '' : String(values.moving),
          stillMinutes: values.still === TRACKER_INTERVALS.still ? '' : String(values.still),
          batteryMinutes: values.battery === TRACKER_INTERVALS.battery ? '' : String(values.battery),
          publicSos: publicSos ? 'on' : '',
          ...Object.fromEntries(TRACKER_PRESSES.map((p) => [`press${p.n}`, text(p.n)])),
        });
      } else {
        // Only what differs from every tracker's: the rest keeps following the circle.
        let custom: TrackerCustom | null = null;
        if (own) {
          const presses: Record<string, string> = {};
          for (const p of TRACKER_PRESSES) {
            const v = values.presses[p.n]?.trim();
            if (v && v !== circle.presses[p.n]) presses[String(p.n)] = v;
          }
          custom = {
            moving: values.moving !== circle.moving ? values.moving : null,
            still: values.still !== circle.still ? values.still : null,
            battery: values.battery !== circle.battery ? values.battery : null,
            presses: Object.keys(presses).length ? presses : null,
          };
        }
        const who = mode === 'carried' ? carriedBy : '';
        await client.setMemberRecord(member, { tracker: { ...tracker!, custom, mode, carriedBy: who || null, beacon: beacon as 0 | 15 | 30 | 60 } });
        // The home base keeps who has it too (it asks this tracker when their phone goes quiet).
        if (home && who !== (tracker!.carriedBy ?? '')) {
          const person = who ? client.members.get(who)?.name : null;
          await tellHomeBase(client, home.id, person ? `link ${tracker!.node} to ${person}` : `unlink ${tracker!.node}`);
        }
      }
      notice('Saved', 'The home base sends the new settings to the tracker within 10 minutes. Messages for presses change right away.');
      router.back();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsPage title={name ? `${name}` : 'Tracker settings'}>
      {member && tracker ? (
        <SettingsGroup title="What it is" footer={mode === 'carried' ? 'When their phone goes quiet, the map shows them where this tracker is.' : undefined}>
          <GroupBody gap={12}>
            <Pills options={TRACKER_KINDS.map((k) => ({ value: k.mode, label: `${k.emoji} ${k.label}` }))} value={mode} onChange={setMode} />
            {mode === 'carried' ? (
              <>
                <Label text="Who has it" />
                <Pills options={[{ value: '', label: 'No one yet' }, ...people.map((p) => ({ value: p.id, label: p.name }))]} value={carriedBy} onChange={setCarriedBy} />
              </>
            ) : null}
          </GroupBody>
        </SettingsGroup>
      ) : null}

      {member ? (
        <SettingsGroup footer={own ? 'This tracker keeps its own settings below.' : 'Change them for every tracker under Trackers → Settings for all trackers.'}>
          <ToggleRow title="Same as every tracker" detail="The circle’s tracker settings" value={!own} onChange={(v) => setOwn(!v)} />
        </SettingsGroup>
      ) : null}

      {member && state ? (
        <SettingsGroup title="On the tracker">
          <GroupBody>
            <P muted>
              {state === 'set'
                ? 'The tracker has these settings. A change made on the tracker itself stays until you change them here.'
                : state === 'sending'
                  ? 'The home base is sending them to the tracker over the radio.'
                  : 'The tracker doesn’t take settings from the home base yet. Add the home base’s key on it once (below).'}
            </P>
          </GroupBody>
          {state === 'needs-key' && home?.status.key ? <KeyHelp keyText={home.status.key} /> : null}
        </SettingsGroup>
      ) : null}

      {values ? (
        <>
          <SettingsGroup
            title="Sending its position"
            footer="More often means a fresher dot on the map and a shorter battery life."
            how={[
              'A tracker sends its position more often while it moves (100 m or more), and less often while it stays put.',
              'The home base puts these on each tracker over the radio, once, when they change here. A tracker needs the home base’s key for that: Trackers shows it if one doesn’t have it yet.',
            ]}
          >
            <GroupBody gap={12}>
              <Label text="While moving, at most every" />
              <Pills options={MOVING} value={nearest(values.moving, MOVING)} onChange={(moving) => set({ moving })} disabled={!editing} />
              <Label text="Otherwise, every" />
              <Pills options={STILL} value={nearest(values.still, STILL)} onChange={(still) => set({ still })} disabled={!editing} />
              <Label text="Battery level, every" />
              <Pills options={BATTERY} value={nearest(values.battery, BATTERY)} onChange={(battery) => set({ battery })} disabled={!editing} />
            </GroupBody>
          </SettingsGroup>

          {member ? (
            <SettingsGroup
              title="Public beacon"
              footer={
                beacon
                  ? `Anyone on the public Meshtastic channel (and its maps) can see roughly where ${name} is, to about 3 km.`
                  : 'Off: its position stays on your private channel.'
              }
              how={[
                'Your private channel reaches HomeCircle only through your home base and your own gateways. The public Meshtastic channel has gateways almost everywhere there are Meshtastic users.',
                'With the beacon on, the tracker also sends a rounded position (about 3 km) on the public channel now and then. Gateways pass it to the public Meshtastic server, and your home base picks it up there, so the tracker shows on your map “via public mesh” far from home.',
                'The cost: that rounded position is public. Turn it on for a trip, off when you’re back. It needs the HomeCircle firmware on the tracker (the T1000-E build).',
              ]}
              howTitle="What the public beacon does"
            >
              <GroupBody>
                <Pills
                  options={[
                    { value: 0, label: 'Off' },
                    { value: 15, label: 'Every 15 min' },
                    { value: 30, label: 'Every 30 min' },
                    { value: 60, label: 'Every hour' },
                  ]}
                  value={beacon}
                  onChange={setBeacon}
                />
              </GroupBody>
            </SettingsGroup>
          ) : (
            <SettingsGroup
              title="SOS"
              footer={
                publicSos
                  ? 'A tracker’s SOS also goes out as plain text with where it is on the public Meshtastic channel. Anyone on it can read it.'
                  : 'An SOS goes only to your circle, on your private channel.'
              }
            >
              <ToggleRow
                title="Also send an SOS on the public channel"
                detail="So any Meshtastic user nearby sees it, when your home base and gateways are out of reach"
                value={publicSos}
                onChange={setPublicSos}
              />
            </SettingsGroup>
          )}

          <SettingsGroup title="Button presses" how={PRESS_HELP} howTitle="The tracker’s button" footer="What each number of presses sends to the circle, from the tracker. Empty uses the message shown.">
            <GroupBody gap={4}>
              {TRACKER_PRESSES.map((p) => (
                <View key={p.n}>
                  <Field
                    label={`${p.n} press${p.n === 1 ? '' : 'es'} · ${p.what}`}
                    value={values.presses[p.n] ?? ''}
                    onChangeText={(v) => set({ presses: { ...values.presses, [p.n]: v } })}
                    placeholder={p.text}
                    maxLength={80}
                    editable={editing}
                  />
                  <Text style={{ color: t.muted, fontSize: 14, lineHeight: 18, marginTop: -10, marginBottom: 12 }}>{p.does}</Text>
                </View>
              ))}
            </GroupBody>
          </SettingsGroup>

          <GroupBody>
            <ErrorText>{error}</ErrorText>
            <Button title="Save" variant="primary" loading={saving} onPress={save} />
          </GroupBody>
        </>
      ) : (
        <GroupBody>
          {error ? <ErrorText>{error}</ErrorText> : <P muted>Loading…</P>}
        </GroupBody>
      )}
    </SettingsPage>
  );
}

function Label({ text }: { text: string }) {
  const t = useTheme();
  return <Text style={{ color: t.muted, fontSize: 14, fontWeight: '700' }}>{text.toUpperCase()}</Text>;
}
