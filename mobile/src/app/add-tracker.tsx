// Add a Meshtastic tracker from its "Share contact" QR code (Meshtastic app →
// the tracker → Share contact), or its link pasted. One way among others: an
// admin can still pick a node under Trackers → Heard nearby, or type
// "add !a1b2c3d4 Name" to the home base in the chat. Either way the home base
// does the adding (its `add` command takes the link and the tracker's key
// from it); then the tracker itself needs two things from the Meshtastic app:
// the circle's channel, and the home base's key as an admin key.
import { useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Button, ErrorText, Field, P } from '../components/ui';
import { Pills } from '../components/Pills';
import { QRCode } from '../components/QRCode';
import { KeyHelp } from '../components/TrackerKeyHelp';
import { GroupBody, SettingsGroup, SettingsPage } from '../components/SettingsKit';
import type { TrackerMode } from '@homecircle/core';
import { errorText } from '../lib/circle';
import { parseContactLink, type MeshContact } from '../lib/meshContact';
import { notice } from '../lib/sheet';
import { homeBaseOf, tellHomeBase, TRACKER_KINDS, trackerList } from '../lib/trackers';
import { timeAgo, useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

export default function AddTracker() {
  const t = useTheme();
  const client = useCircle(['members', 'records', 'status']);
  const home = homeBaseOf(client);
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const handled = useRef(false);
  const [pasted, setPasted] = useState('');
  const [contact, setContact] = useState<MeshContact | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TrackerMode>('carried');
  const [carriedBy, setCarriedBy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [added, setAdded] = useState(false);
  const people = client.peopleList().filter((p) => p.kind !== 'agent' && p.id !== home?.id);

  const use = (text: string) => {
    const c = parseContactLink(text);
    if (!c) {
      setError('That isn’t a Meshtastic Share contact link. In the Meshtastic app, open the tracker and choose Share contact.');
      return false;
    }
    if (trackerList(client).some((x) => x.tracker.node === c.node)) {
      setError(`${c.longName || c.node} is already one of your trackers.`);
      return false;
    }
    setError(null);
    setContact(c);
    setName(c.longName || c.shortName || '');
    return true;
  };

  const add = async () => {
    if (!home || !contact) return;
    setSending(true);
    setError(null);
    try {
      const who = kind === 'carried' && carriedBy ? client.members.get(carriedBy)?.name : null;
      // The node id works with every home base; the contact then gives a newer one the tracker's key too.
      await tellHomeBase(client, home.id, `add ${contact.node} ${name.trim()}${kind === 'carried' ? '' : ` as ${kind}`}`);
      await tellHomeBase(client, home.id, `contact ${contact.link}`);
      if (who) await tellHomeBase(client, home.id, `link ${contact.node} to ${who}`);
      setAdded(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };

  if (!client.isAdmin || !home) {
    return (
      <SettingsPage title="Add a tracker">
        <GroupBody>
          <P muted>{home ? 'Only the circle’s admins add trackers.' : 'Set up a home base first: trackers are added through it.'}</P>
        </GroupBody>
      </SettingsPage>
    );
  }

  if (scanning && permission?.granted) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (handled.current) return;
            handled.current = true;
            if (use(data)) setScanning(false);
            else setTimeout(() => (handled.current = false), 1500); // let them try another code
          }}
        />
        <View style={{ position: 'absolute', left: 20, right: 20, bottom: 48, gap: 12 }}>
          <Text style={{ color: '#fff', textAlign: 'center', fontSize: 16, fontWeight: '600' }}>Point at the tracker’s Share contact QR code</Text>
          {error ? <Text style={{ color: '#ffb4a6', textAlign: 'center' }}>{error}</Text> : null}
          <Button title="Cancel" onPress={() => setScanning(false)} />
        </View>
      </View>
    );
  }

  // Added: what's left is on the tracker itself, in the Meshtastic app.
  if (added && contact) {
    const channel = home.status.channel;
    return (
      <SettingsPage title={`Finish setting up ${name.trim() || 'the tracker'}`}>
        <SettingsGroup title="1. Put it on your channel" footer="It then sends its position on your private HomeCircle channel, on your home base’s frequency.">
          <GroupBody>
            <P muted>On the phone that’s connected to the tracker in the Meshtastic app, scan this code (or tap Open in Meshtastic) and accept the channel.</P>
            {channel ? (
              <>
                <View style={{ alignItems: 'center' }}>
                  <QRCode value={channel} size={220} />
                </View>
                <Button title="Open in Meshtastic" onPress={() => Linking.openURL(channel).catch(() => notice('Couldn’t open it', 'Is the Meshtastic app installed on this phone?'))} />
              </>
            ) : (
              <P muted>Send “channel” to the home base in the chat for the link.</P>
            )}
          </GroupBody>
        </SettingsGroup>
        {home.status.key ? (
          <SettingsGroup title="2. Let the home base set it" footer="Then HomeCircle sets how often it reports, its buzzer and its button over the radio: nothing more to do on the tracker.">
            <KeyHelp keyText={home.status.key} />
          </SettingsGroup>
        ) : null}
        <GroupBody>
          <Button title="Done" variant="primary" onPress={() => router.back()} />
        </GroupBody>
      </SettingsPage>
    );
  }

  const heard = contact ? home.status.heard.find((h) => h.node === contact.node) : null;
  return (
    <SettingsPage title="Add a tracker">
      {!contact ? (
        <SettingsGroup
          title="From its QR code"
          how={[
            'In the Meshtastic app, connect to the tracker, open it in the list of nodes, and choose Share contact. It shows a QR code.',
            'You can also add a tracker the home base has heard (Trackers → Heard nearby), or send “add !a1b2c3d4 Name” to the home base in the chat.',
          ]}
        >
          <GroupBody>
            <Button
              title="Scan its QR code"
              variant="primary"
              onPress={async () => {
                const p = permission?.granted ? permission : await requestPermission();
                if (p.granted) {
                  handled.current = false;
                  setScanning(true);
                } else {
                  notice('Camera is off for HomeCircle', 'Turn it on in the phone’s Settings, or paste the link below.');
                }
              }}
            />
            <Field label="Or paste its Share contact link" value={pasted} onChangeText={setPasted} placeholder="https://meshtastic.org/v/#…" autoCapitalize="none" autoCorrect={false} />
            <Button title="Use this link" disabled={!pasted.trim()} onPress={() => use(pasted)} />
            <ErrorText>{error}</ErrorText>
          </GroupBody>
        </SettingsGroup>
      ) : (
        <>
          <SettingsGroup title="The tracker">
            <GroupBody>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>
                {[contact.model, contact.node].filter(Boolean).join(' · ')}
              </Text>
              <P muted>
                {heard?.at
                  ? `The home base heard it ${timeAgo(heard.at)}.`
                  : 'The home base hasn’t heard it yet. That’s fine: it shows up once it’s on your channel (step 1 after adding).'}
              </P>
              <Field label="Name on the map" value={name} onChangeText={setName} placeholder="Leo’s tracker, Rex, Honda CR-V…" maxLength={40} />
            </GroupBody>
          </SettingsGroup>
          <SettingsGroup title="What it is">
            <GroupBody gap={12}>
              <Pills options={TRACKER_KINDS.map((k) => ({ value: k.mode, label: `${k.emoji} ${k.label}` }))} value={kind} onChange={setKind} />
              {kind === 'carried' ? (
                <Pills options={[{ value: '', label: 'No one yet' }, ...people.map((p) => ({ value: p.id, label: p.name }))]} value={carriedBy} onChange={setCarriedBy} />
              ) : null}
            </GroupBody>
          </SettingsGroup>
          <GroupBody>
            <ErrorText>{error}</ErrorText>
            <Button title="Add tracker" variant="primary" loading={sending} disabled={!name.trim()} onPress={add} />
            <Button title="Scan a different one" variant="ghost" onPress={() => (setContact(null), setPasted(''))} />
          </GroupBody>
        </>
      )}
    </SettingsPage>
  );
}
