// Trackers: Meshtastic trackers kept by the circle's home base (a Meshtastic
// node at home; devices/meshtastic). Everything here is the home base's own
// commands, sent as a direct message to it, the same ones an admin can type
// in the chat with it (add, rename, link, unlink, remove). Its answers arrive
// in that chat; this screen follows the records and locations as they change.
import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Text, View } from 'react-native';
import type { CircleClient, TrackerMode } from '@homecircle/core';
import { Button, Field, P } from '../components/ui';
import { Pills } from '../components/Pills';
import { GroupBody, SettingsGroup, SettingsPage, SettingsRow } from '../components/SettingsKit';
import { errorText } from '../lib/circle';
import { radioLine } from '../lib/people';
import { confirm, notice, showSheet } from '../lib/sheet';
import { compareVersions, latestHomeBaseFirmware, type HomeBaseFirmware, homeBaseHealth, homeBaseOf, homeBaseOnline, PRESS_HELP, oldHomeBases, radioFacts, tellHomeBase, trackerEmoji, trackerList, TRACKER_KINDS, trackerSettingsLine, tripLine, useNow } from '../lib/trackers';
import { KeyHelp } from '../components/TrackerKeyHelp';
import { timeAgo, useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

const EVENTS = ['members', 'locations', 'records', 'status', 'places'] as const;

type Kind = TrackerMode;

/** People a tracker can belong to: everyone but trackers and the home base. */
function people(client: CircleClient, homeBaseId: string | null) {
  const trackers = new Set(trackerList(client).map((t) => t.id));
  return client.peopleList().filter((m) => m.kind !== 'agent' && m.id !== homeBaseId && !trackers.has(m.id));
}

export default function Trackers() {
  const t = useTheme();
  const client = useCircle(EVENTS);
  const home = homeBaseOf(client);
  const trackers = trackerList(client);
  const admin = client.isAdmin;
  const now = useNow();
  // One form at a time: adding a heard node, renaming or linking a tracker.
  const [adding, setAdding] = useState<{ node: string; name: string; kind: Kind; carriedBy: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; node: string; name: string } | null>(null);
  const [linking, setLinking] = useState<{ id: string; node: string; carriedBy: string } | null>(null);
  const [sending, setSending] = useState(false);
  // The home base firmware on the latest release: offered as an update over Wi-Fi.
  const [latest, setLatest] = useState<HomeBaseFirmware | null>(null);
  useEffect(() => {
    let alive = true;
    latestHomeBaseFirmware().then((f) => alive && setLatest(f));
    return () => {
      alive = false;
    };
  }, []);

  const send = async (commands: string[]) => {
    if (!home) return;
    setSending(true);
    try {
      for (const c of commands) await tellHomeBase(client, home.id, c);
      notice('Sent to the home base', 'It answers in your chat with it, usually within half a minute, and this list updates by itself.');
      setAdding(null);
      setRenaming(null);
      setLinking(null);
    } catch (e) {
      notice('Couldn’t send it', errorText(e));
    } finally {
      setSending(false);
    }
  };

  const pickPerson = (value: string, onChange: (v: string) => void) => (
    <Pills
      options={[{ value: '', label: 'Nobody' }, ...people(client, home?.id ?? null).map((m) => ({ value: m.id, label: m.name }))]}
      value={value}
      onChange={onChange}
    />
  );

  // Where the home base shows on the map: pinned to a place (its home address), or its GPS.
  const pin = client.homeBasePlace();
  const gps = home?.status.gps;
  const gpsLine = !gps ? 'no GPS' : gps.fix ? `GPS fix, ${gps.sats ?? '?'} satellites` : 'GPS: no fix yet';
  const pinTo = (placeId: string | null) =>
    client.pinHomeBase(placeId).catch((e) => notice('Couldn’t change it', errorText(e)));
  const choosePin = () => {
    const places = [...client.places.values()].sort((a, b) => Number(/^home$/i.test(b.name)) - Number(/^home$/i.test(a.name)) || a.name.localeCompare(b.name));
    showSheet('Where is the home base?', 'It shows on the map at this place, whatever its GPS says. Its GPS is still checked and shown here.', [
      ...places.filter((p) => p.id !== pin?.id).slice(0, 4).map((p) => ({ text: `At ${p.name}${p.address ? ` · ${p.address}` : ''}`, onPress: () => void pinTo(p.id) })),
      { text: 'Add its address…', onPress: () => router.push({ pathname: '/add-place', params: { homeBase: '1' } }) },
      ...(pin ? [{ text: 'Use its GPS instead', onPress: () => void pinTo(null) }] : []),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  const online = home ? homeBaseOnline(home.status, now) : false;
  const fw = home?.status.fw ?? null;
  const newer = fw && latest && compareVersions(latest.version, fw) > 0 ? latest : null;
  const update = async () => {
    if (!home || !newer) return;
    const mb = (newer.size / 1048576).toFixed(1);
    if (!(await confirm(`Update the home base to ${newer.version}?`, `It downloads ${mb} MB over its Wi-Fi, checks it, and restarts (about 2 minutes, with no tracker updates meanwhile). If the new version doesn’t start properly, it goes back to ${fw} by itself. It tells you in its chat how it went.`, 'Update'))) return;
    try {
      await tellHomeBase(client, home.id, `update ${newer.url} ${newer.sha256}`);
      notice('Updating the home base', 'It answers in your chat with it, and again when it’s back on the new version.');
    } catch (e) {
      notice('Couldn’t send it', errorText(e));
    }
  };
  const health = home && online ? homeBaseHealth(home.status) : null;
  const tracked = new Set(trackers.map((x) => x.tracker.node));
  const heard = (home?.status.heard ?? []).filter((h) => !tracked.has(h.node));

  return (
    <SettingsPage title="Trackers">
      <SettingsGroup
        title="Home base"
        how={[
          'A home base is a Meshtastic node at home (a Heltec V4 with HomeCircle) on your Wi-Fi. It hears Meshtastic trackers over the radio and puts them on the map, even when the person carrying one has no phone signal.',
          'Each tracker is its own pin with the name you give it. Locate, Chirp and Ask to check in reach it over the radio.',
        ]}
      >
        {home ? (
          <SettingsRow
            icon="home"
            title={home.name}
            detail={`${online ? 'Online' : 'Offline'} · checked in ${timeAgo(home.status.at)}${client.memberRecord(home.id) && client.members.get(home.id)?.role === 'member' ? ' · make it an admin so it can add trackers' : ''}`}
          />
        ) : null}
        {home ? (
          <SettingsRow
            icon="place"
            title={pin ? `At ${pin.name}` : 'Home address'}
            detail={pin ? `${pin.address ? `${pin.address} · ` : ''}pinned there on the map · ${gpsLine}` : `Not set: it shows where its GPS says (${gpsLine}). Tap to pin it to your home`}
            onPress={choosePin}
          />
        ) : null}
        {home ? (
          <SettingsRow
            icon="refresh"
            title={newer ? `Update to ${newer.version}` : `Firmware ${fw ?? 'older than 0.29'}`}
            detail={
              newer
                ? `It runs ${fw}. ${admin ? 'Tap to update it over its Wi-Fi' : 'An admin can update it over its Wi-Fi'}`
                : fw
                  ? latest
                    ? 'Up to date'
                    : 'Updates over its Wi-Fi from the app'
                  : 'Update it over USB once (devices/meshtastic); after that it updates over its Wi-Fi from here'
            }
            badge={newer ? '1' : null}
            onPress={newer && admin ? update : undefined}
          />
        ) : null}
        {home && health ? (
          <GroupBody>
            <P muted>{health}</P>
          </GroupBody>
        ) : null}
        {home ? null : (
          <GroupBody>
            <P muted>No home base in this circle yet. Set one up with an invite, then make it an admin here.</P>
          </GroupBody>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Trackers"
        footer={trackers.length ? undefined : 'Trackers you add show here and on the map.'}
        how={PRESS_HELP}
        howTitle="The tracker’s button"
      >
        {trackers.map((x) => {
          const loc = client.locations.get(x.id);
          const carrier = x.tracker.carriedBy ? client.members.get(x.tracker.carriedBy) : null;
          const path = radioLine(loc);
          const detail = [
            x.tracker.mode !== 'carried' ? (TRACKER_KINDS.find((k) => k.mode === x.tracker.mode)?.label ?? 'Something else') : carrier ? `${carrier.name} has it` : 'No one has it yet',
            loc ? `last position ${timeAgo(loc.ts)}` : 'no position yet',
            path && loc?.mesh?.hops != null ? (loc.mesh.hops === 0 ? 'heard directly' : `${loc.mesh.hops} hop${loc.mesh.hops === 1 ? '' : 's'}`) : null,
            radioFacts(home?.status.trackers.find((s) => s.node === x.tracker.node)?.radio),
            tripLine(home?.status.trackers.find((s) => s.node === x.tracker.node)?.log ?? [], now),
            x.tracker.custom ? 'its own settings' : null,
            admin ? trackerSettingsLine(home?.status.trackers.find((s) => s.node === x.tracker.node)?.settings) : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <View key={x.id}>
              <SettingsRow
                icon="locate"
                title={`${trackerEmoji(x.tracker)} ${x.name}`}
                detail={detail}
                onPress={
                  admin && home
                    ? () =>
                        showSheet(x.name, path ?? undefined, [
                          { text: 'Settings', onPress: () => router.push({ pathname: '/tracker-settings', params: { member: x.id } }) },
                          { text: 'Rename', onPress: () => setRenaming({ id: x.id, node: x.tracker.node!, name: x.name }) },
                          { text: 'Who carries it', onPress: () => setLinking({ id: x.id, node: x.tracker.node!, carriedBy: x.tracker.carriedBy ?? '' }) },
                          {
                            text: 'Remove',
                            style: 'destructive',
                            onPress: async () => {
                              if (await confirm(`Remove ${x.name}?`, 'It leaves the circle and its pin goes. The tracker itself keeps working in Meshtastic.', 'Remove', { destructive: true }))
                                send([`remove ${x.tracker.node}`]);
                            },
                          },
                          { text: 'Cancel', style: 'cancel' },
                        ])
                    : undefined
                }
              />
              {renaming?.id === x.id ? (
                <GroupBody>
                  <Field label="New name" value={renaming.name} onChangeText={(name) => setRenaming({ ...renaming, name })} autoFocus maxLength={40} />
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <Button title="Cancel" variant="ghost" onPress={() => setRenaming(null)} style={{ flex: 1 }} />
                    <Button
                      title="Rename"
                      variant="primary"
                      loading={sending}
                      disabled={!renaming.name.trim()}
                      onPress={() => send([`rename ${renaming.node} to ${renaming.name.trim()}`])}
                      style={{ flex: 1 }}
                    />
                  </View>
                </GroupBody>
              ) : null}
              {linking?.id === x.id ? (
                <GroupBody>
                  <Text style={{ color: t.muted, fontSize: 14 }}>Who carries it? When their phone goes quiet, the home base asks this tracker where it is, and the map shows them there.</Text>
                  {pickPerson(linking.carriedBy, (carriedBy) => setLinking({ ...linking, carriedBy }))}
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <Button title="Cancel" variant="ghost" onPress={() => setLinking(null)} style={{ flex: 1 }} />
                    <Button
                      title="Save"
                      variant="primary"
                      loading={sending}
                      onPress={() => {
                        const who = linking.carriedBy ? client.members.get(linking.carriedBy)?.name : null;
                        send([who ? `link ${linking.node} to ${who}` : `unlink ${linking.node}`]);
                      }}
                      style={{ flex: 1 }}
                    />
                  </View>
                </GroupBody>
              ) : null}
            </View>
          );
        })}
      </SettingsGroup>

      {admin && oldHomeBases(client, now).length ? (
        <SettingsGroup
          title="Old home bases"
          footer="A home base that joined the circle again leaves its old entry behind, silent. Remove it so only the one in use shows."
        >
          {oldHomeBases(client, now).map((o) => (
            <SettingsRow
              key={o.id}
              icon="home"
              title={o.name}
              detail={`Silent since ${timeAgo(o.at)} · tap to remove`}
              onPress={async () => {
                if (!(await confirm(`Remove this ${o.name}?`, 'It’s an old entry: the home base in use stays.', 'Remove', { destructive: true }))) return;
                client.removeMember(o.id).catch((e) => notice('Couldn’t remove it', errorText(e)));
              }}
            />
          ))}
        </SettingsGroup>
      ) : null}

      {admin && home ? (
        <SettingsGroup title="Add and set up">
          <SettingsRow
            icon="qr"
            title="Add a tracker with its QR code"
            detail="Its Share contact in the Meshtastic app, scanned or pasted. Or pick one under Heard nearby."
            href="/add-tracker"
          />
          <SettingsRow
            icon="settings"
            title="Settings for all trackers"
            detail="How often they send their position, and what each number of button presses says"
            href="/tracker-settings"
          />
        </SettingsGroup>
      ) : null}

      {admin && home?.status.key && home.status.trackers.some((x) => x.settings === 'needs-key') ? (
        <SettingsGroup
          title="Let the home base set your trackers"
          footer={`Needed by ${trackers
            .filter((x) => home.status.trackers.find((s) => s.node === x.tracker.node)?.settings === 'needs-key')
            .map((x) => x.name)
            .join(', ')}.`}
        >
          <KeyHelp keyText={home.status.key} />
        </SettingsGroup>
      ) : null}

      {admin && home ? (
        <SettingsGroup
          title="Heard nearby"
          footer={heard.length ? 'Meshtastic nodes the home base heard in the last two hours. Tap one to add it as a tracker.' : 'No other Meshtastic nodes heard lately. Put the tracker on your private channel first: send “channel” to the home base for the link.'}
        >
          {heard.map((h) => (
            <View key={h.node}>
              <SettingsRow
                icon="plus"
                title={h.name || h.node}
                detail={[h.node, h.at ? `heard ${timeAgo(h.at)}` : null, h.hops != null ? (h.hops === 0 ? 'direct' : `${h.hops} hop${h.hops === 1 ? '' : 's'}`) : null, radioFacts(h)].filter(Boolean).join(' · ')}
                onPress={() => setAdding({ node: h.node, name: h.name ?? '', kind: 'carried', carriedBy: '' })}
              />
              {adding?.node === h.node ? (
                <GroupBody>
                  <Field label="Name on the map" value={adding.name} onChangeText={(name) => setAdding({ ...adding, name })} placeholder="Leo’s tracker, Honda CR-V…" autoFocus maxLength={40} />
                  <Pills
                    options={[
                      ...TRACKER_KINDS.map((k) => ({ value: k.mode, label: `${k.emoji} ${k.label}` })),
                    ]}
                    value={adding.kind}
                    onChange={(kind) => setAdding({ ...adding, kind, carriedBy: kind === 'carried' ? adding.carriedBy : '' })}
                  />
                  {adding.kind === 'carried' ? pickPerson(adding.carriedBy, (carriedBy) => setAdding({ ...adding, carriedBy })) : null}
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <Button title="Cancel" variant="ghost" onPress={() => setAdding(null)} style={{ flex: 1 }} />
                    <Button
                      title="Add"
                      variant="primary"
                      loading={sending}
                      disabled={!adding.name.trim()}
                      onPress={() => {
                        const name = adding.name.trim();
                        const who = adding.carriedBy ? client.members.get(adding.carriedBy)?.name : null;
                        send([`add ${adding.node} ${name}${adding.kind === 'carried' ? '' : ` as ${adding.kind}`}`, ...(who ? [`link ${adding.node} to ${who}`] : [])]);
                      }}
                      style={{ flex: 1 }}
                    />
                  </View>
                </GroupBody>
              ) : null}
            </View>
          ))}
        </SettingsGroup>
      ) : null}
    </SettingsPage>
  );
}
