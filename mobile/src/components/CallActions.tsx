import { useEffect, useState } from 'react';
import { Modal, Pressable, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { CircleClient } from '@homecircle/core';
import { Button, Icon } from './ui';
import { GroupCallSheet } from './GroupCallSheet';
import { canCall, meshAvailable, startCall } from '../lib/calls';
import { errorText } from '../lib/circle';
import { joinGroupCall } from '../lib/groupCalls';
import { openChat, openGroupCallLink, showOutcome } from '../lib/whatsapp';
import { useSkin } from '../skins';
import { useTheme } from '../theme';
import { showSheet } from '../lib/sheet';

/**
 * The number to call someone on, or null: nothing when the circle hasn't
 * turned the WhatsApp plugin on; theirs (sealed in their profile, or
 * saved by an admin for an elder), never your own, and never on an elder's own
 * phone (she asks for a call; she doesn't place them).
 */
function usePhone(client: CircleClient, memberId: string): string | null {
  const [, bump] = useState(0);
  const skin = useSkin();
  useEffect(() => {
    const offs = ['records', 'members', 'circle'].map((e) => client.on(e, () => bump((n) => n + 1)));
    return () => offs.forEach((off) => off());
  }, [client]);
  const m = client.members.get(memberId);
  if (!client.feature('whatsapp') || skin === 'elderly' || !m || m.isMe || m.removed || m.kind === 'agent') return null;
  return client.phoneOf(memberId);
}

const call = (phone: string) => openChat(phone).then(showOutcome);

/**
 * Call → two buttons: in HomeCircle (voice, phone to phone) or on WhatsApp
 * (their number). A button that can't be used says why instead.
 */
export function CallChoiceSheet({ client, memberId, visible, onClose, onCalled }: { client: CircleClient; memberId: string; visible: boolean; onClose: () => void; onCalled: () => void }) {
  const t = useTheme();
  const phone = usePhone(client, memberId);
  const inApp = canCall(client, memberId);
  const name = client.displayName(memberId);
  const why = (text: string) => <Text style={{ color: t.muted, fontSize: 14, textAlign: 'center' }}>{text}</Text>;
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={{ flex: 1, backgroundColor: t.scrim, justifyContent: 'flex-end' }}>
        <Pressable accessible={false} onPress={() => {}} style={{ backgroundColor: t.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22 }}>
          <SafeAreaView edges={['bottom']} style={{ padding: 18, gap: 12 }}>
            <Text style={{ color: t.text, fontSize: 20, fontWeight: '700' }}>Call {name}</Text>
            <Button
              variant="primary"
              title="Call in HomeCircle"
              disabled={!inApp}
              onPress={() => {
                onCalled();
                startCall(client, memberId).catch((e) => showSheet('Couldn’t call', errorText(e)));
              }}
            />
            {inApp ? why('Voice, phone to phone, only you two') : why(client.feature('calls') ? 'Not on this phone yet (Android only for now).' : 'Voice calls are off for this circle. An admin turns them on in Settings → Features.')}
            <Button
              title="Call on WhatsApp"
              disabled={!phone}
              onPress={() => {
                onCalled();
                void call(phone!);
              }}
            />
            {phone
              ? why(`Opens WhatsApp with ${phone}`)
              : why(
                  client.feature('whatsapp')
                    ? `No phone number for ${name} yet. Add it in Settings → your circle → People → ${name}.`
                    : 'WhatsApp links are off for this circle. An admin turns them on in Settings → Features.',
                )}
          </SafeAreaView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** "Call on WhatsApp" as a wide button (a call-back card, the reply sheet). Nothing when they have no number. */
export function WhatsAppCallButton({ client, memberId, label = 'Call on WhatsApp', onDone }: { client: CircleClient; memberId: string; label?: string; onDone?: () => void }) {
  const t = useTheme();
  const phone = usePhone(client, memberId);
  if (!phone) return null;
  const name = client.displayName(memberId);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Call ${name} on WhatsApp. Opens their chat, one tap from calling`}
      onPress={() => {
        onDone?.();
        void call(phone);
      }}
      style={({ pressed }) => ({
        minHeight: 48,
        borderRadius: 14,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: 12,
        borderWidth: 1,
        borderColor: t.brand,
        backgroundColor: pressed ? t.brandSoft : 'transparent',
      })}
    >
      <Icon name="phone" color={t.brand} size={20} />
      <Text style={{ color: t.brand, fontSize: 16, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}

/**
 * Call, in a direct chat's header: opens the same choice as the person sheet
 * (in HomeCircle or on WhatsApp). Nothing for the helper or someone who left.
 */
export function CallButton({ client, memberId }: { client: CircleClient; memberId: string }) {
  const t = useTheme();
  const skin = useSkin();
  const [sheet, setSheet] = useState(false);
  const m = client.members.get(memberId);
  if (!(client.feature('calls') || client.feature('whatsapp')) || skin === 'elderly' || !m || m.isMe || m.removed || m.kind === 'agent') return null;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Call ${client.displayName(memberId)}`}
        accessibilityHint="In HomeCircle or on WhatsApp"
        onPress={() => setSheet(true)}
        hitSlop={4}
        style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, borderRadius: 22, borderWidth: 1, borderColor: t.line, backgroundColor: pressed ? t.surface2 : t.surface })}
      >
        <Icon name="phone" color={t.brand} size={20} />
        <Text style={{ color: t.brand, fontSize: 14, fontWeight: '700' }}>Call</Text>
      </Pressable>
      <CallChoiceSheet client={client} memberId={memberId} visible={sheet} onClose={() => setSheet(false)} onCalled={() => setSheet(false)} />
    </>
  );
}

/**
 * Group call, in a group chat's header. A tap joins or starts it in HomeCircle.
 * Where that can't work, the circle's WhatsApp link opens WhatsApp's call lobby;
 * with no link yet (or on a long press) a sheet lets an admin paste it.
 */
export function GroupCallButton({ client }: { client: CircleClient }) {
  const t = useTheme();
  const skin = useSkin();
  const [sheet, setSheet] = useState(false);
  const [, bump] = useState(0);
  useEffect(() => client.on('circle', () => bump((n) => n + 1)), [client]);
  const mesh = meshAvailable(client);
  if (!(mesh || client.feature('whatsapp')) || skin === 'elderly') return null;
  const link = client.groupCallLink;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Group call"
        accessibilityHint={mesh ? 'Starts or joins the call in HomeCircle. Long-press for WhatsApp' : link ? 'Opens the group call on WhatsApp. Long-press to change the link' : 'Sets up the group call link'}
        onPress={() => (mesh ? void joinGroupCall(client, null) : link ? void openGroupCallLink(link).then(showOutcome) : setSheet(true))}
        onLongPress={() => setSheet(true)}
        delayLongPress={400}
        hitSlop={4}
        style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, borderRadius: 22, borderWidth: 1, borderColor: t.line, backgroundColor: pressed ? t.surface2 : t.surface })}
      >
        <Icon name="phone" color={t.brand} size={20} />
        <Text style={{ color: t.brand, fontSize: 14, fontWeight: '700' }}>Group call</Text>
      </Pressable>
      <GroupCallSheet client={client} visible={sheet} onClose={() => setSheet(false)} />
    </>
  );
}

/** The WhatsApp plugin's settings, under its switch in Settings → Features: the circle's group call link (admins). */
export function WhatsAppSetup({ client }: { client: CircleClient }) {
  const t = useTheme();
  const [sheet, setSheet] = useState(false);
  const [, bump] = useState(0);
  useEffect(() => client.on('circle', () => bump((n) => n + 1)), [client]);
  const link = client.groupCallLink;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Group call link"
        onPress={() => setSheet(true)}
        style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
      >
        <Text style={{ color: t.brand, fontSize: 15, fontWeight: '700' }}>{link ? 'Group call link · change' : 'Add the group call link'}</Text>
        <Text style={{ color: t.muted, fontSize: 14 }}>{link ? link.replace('https://', '') : 'People tap Group call in the group chat to join it. Phone numbers go in Settings → You → Profile.'}</Text>
      </Pressable>
      <GroupCallSheet client={client} visible={sheet} onClose={() => setSheet(false)} />
    </>
  );
}
