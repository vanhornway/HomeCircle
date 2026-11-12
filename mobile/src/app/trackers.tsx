// Trackers: Meshtastic trackers kept by the circle's home base (a Meshtastic
// node at home; devices/meshtastic). Everything here is the home base's own
// commands, sent as a direct message to it, the same ones an admin can type
// in the chat with it (add, rename, link, unlink, remove). Its answers arrive
// in that chat; this screen follows the records and locations as they change.
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { CircleClient } from '@homecircle/core';
import { Button, Field, P } from '../components/ui';
import { GroupBody, SettingsGroup, SettingsPage, SettingsRow } from '../components/SettingsKit';
import { errorText } from '../lib/circle';
import { radioLine } from '../lib/people';
import { confirm, notice, showSheet } from '../lib/sheet';
import { homeBaseHealth, homeBaseOf, homeBaseOnline, radioFacts, tellHomeBase, trackerEmoji, trackerList, useNow } from '../lib/trackers';
import { timeAgo, useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

const EVENTS = ['members', 'locations', 'records', 'status'] as const;

type Kind = 'person' | 'car';

/** Small choice pills: who carries it, person or car. */
function Pills<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.value)}
            style={{ minHeight: 44, paddingHorizontal: 14, borderRadius: 22, justifyContent: 'center', backgroundColor: on ? t.brand : t.surface2 }}
          >
            <Text style={{ color: on ? t.brandInk : t.text, fontSize: 15, fontWeight: '600' }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** People a tracker can belong to: everyone but trackers and the home base. */
function people(client: CircleClient, homeBaseId: string | null) {
  const trackers = new Set(trackerList(client).map((t) => t.id));
  return client.memberList().filter((m) => m.kind !== 'agent' && m.id !== homeBaseId && !trackers.has(m.id));
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

  const online = home ? homeBaseOnline(home.status, now) : false;
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

      <SettingsGroup title="Trackers" footer={trackers.length ? undefined : 'Trackers you add show here and on the map.'}>
        {trackers.map((x) => {
          const loc = client.locations.get(x.id);
          const carrier = x.tracker.carriedBy ? client.members.get(x.tracker.carriedBy) : null;
          const path = radioLine(loc);
          const detail = [
            x.tracker.mode === 'car' ? 'Car' : carrier ? `Carried by ${carrier.name}` : 'Not linked to anyone',
            loc ? `last position ${timeAgo(loc.ts)}` : 'no position yet',
            path && loc?.mesh?.hops != null ? (loc.mesh.hops === 0 ? 'heard directly' : `${loc.mesh.hops} hop${loc.mesh.hops === 1 ? '' : 's'}`) : null,
            radioFacts(home?.status.trackers.find((s) => s.node === x.tracker.node)?.radio),
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
                onPress={() => setAdding({ node: h.node, name: h.name ?? '', kind: 'person', carriedBy: '' })}
              />
              {adding?.node === h.node ? (
                <GroupBody>
                  <Field label="Name on the map" value={adding.name} onChangeText={(name) => setAdding({ ...adding, name })} placeholder="Leo’s tracker, Honda CR-V…" autoFocus maxLength={40} />
                  <Pills
                    options={[
                      { value: 'person' as Kind, label: '🎒 Someone carries it' },
                      { value: 'car' as Kind, label: '🚗 It’s in a car' },
                    ]}
                    value={adding.kind}
                    onChange={(kind) => setAdding({ ...adding, kind, carriedBy: kind === 'car' ? '' : adding.carriedBy })}
                  />
                  {adding.kind === 'person' ? pickPerson(adding.carriedBy, (carriedBy) => setAdding({ ...adding, carriedBy })) : null}
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
                        send([`add ${adding.node} ${name}${adding.kind === 'car' ? ' as car' : ''}`, ...(who ? [`link ${adding.node} to ${who}`] : [])]);
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
