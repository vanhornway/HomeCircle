import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';
import type { CircleClient } from '@homecircle/core';
import { Icon } from './ui';
import { GroupCallSheet } from './GroupCallSheet';
import { openChat, openGroupCallLink, showOutcome } from '../lib/whatsapp';
import { useSkin } from '../skins';
import { useTheme } from '../theme';

/**
 * The number to call someone on, or null: theirs (sealed in their profile, or
 * saved by an admin for an elder), never your own, and never on an elder's own
 * phone (she asks for a call; she doesn't place them).
 */
function usePhone(client: CircleClient, memberId: string): string | null {
  const [, bump] = useState(0);
  const skin = useSkin();
  useEffect(() => client.on('records', () => bump((n) => n + 1)), [client]);
  const m = client.members.get(memberId);
  if (skin === 'elderly' || !m || m.isMe || m.removed || m.kind === 'agent') return null;
  return client.phoneOf(memberId);
}

const call = (phone: string) => openChat(phone).then(showOutcome);

/** "Call on WhatsApp" as a tile in a person's sheet (same look as its other tiles). Nothing when they have no number. */
export function WhatsAppTile({ client, memberId, onDone }: { client: CircleClient; memberId: string; onDone?: () => void }) {
  const t = useTheme();
  const phone = usePhone(client, memberId);
  if (!phone) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Call on WhatsApp. Opens their chat, one tap from calling"
      onPress={() => {
        onDone?.();
        void call(phone);
      }}
      style={({ pressed }) => ({ width: '48%', minHeight: 76, borderRadius: 16, borderWidth: 1, borderColor: t.line, backgroundColor: pressed ? t.surface2 : t.bg, padding: 12, gap: 4 })}
    >
      <Icon name="phone" color={t.brand} size={24} />
      <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>Call on WhatsApp</Text>
      <Text style={{ color: t.muted, fontSize: 12 }} numberOfLines={1}>
        Opens their chat
      </Text>
    </Pressable>
  );
}

/** "Call on WhatsApp" as a wide button (a call-back card, the reply sheet). Nothing when they have no number. */
export function WhatsAppCallButton({ client, memberId, onDone }: { client: CircleClient; memberId: string; onDone?: () => void }) {
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
      <Text style={{ color: t.brand, fontSize: 16, fontWeight: '700' }}>Call on WhatsApp</Text>
    </Pressable>
  );
}

/**
 * Group call, in a group chat's header. With the circle's WhatsApp call link
 * saved, one tap opens WhatsApp's call lobby. Without one (or on a long press)
 * a sheet lets an admin paste it.
 */
export function GroupCallButton({ client }: { client: CircleClient }) {
  const t = useTheme();
  const skin = useSkin();
  const [sheet, setSheet] = useState(false);
  const [, bump] = useState(0);
  useEffect(() => client.on('circle', () => bump((n) => n + 1)), [client]);
  if (skin === 'elderly') return null;
  const link = client.groupCallLink;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Group call"
        accessibilityHint={link ? 'Opens the group call on WhatsApp. Long-press to change the link' : 'Sets up the group call link'}
        onPress={() => (link ? void openGroupCallLink(link).then(showOutcome) : setSheet(true))}
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
