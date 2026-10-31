import { useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { CircleClient } from '@homecircle/core';
import { Button } from './ui';
import { errorText } from '../lib/circle';
import { inAppCalls } from '../lib/inAppCalls';
import { openGroupCallLink, showOutcome } from '../lib/whatsapp';
import { cleanCallUrl } from '../lib/whatsappCore';
import { useTheme } from '../theme';

/**
 * The circle's WhatsApp group call link, in a bottom sheet. An admin pastes
 * it (it is checked, then sealed in the circle's record like the circle's
 * name, so only the circle can read it); everyone else just joins.
 */
export function GroupCallSheet({ client, visible, onClose }: { client: CircleClient; visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const link = client.groupCallLink;
  const admin = client.isAdmin;
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const editing = admin && (!link || changing);
  const inApp = inAppCalls();

  const close = () => {
    setDraft('');
    setProblem(null);
    setChanging(false);
    onClose();
  };

  const save = async (value: string) => {
    if (value && !cleanCallUrl(value)) {
      setProblem('That isn’t a WhatsApp call link. It starts with https://call.whatsapp.com/');
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await client.setGroupCallLink(value);
      setDraft('');
      setChanging(false);
      if (!value) onClose();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    const text = (await Clipboard.getStringAsync().catch(() => '')).trim();
    if (text) setDraft(text);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <Pressable onPress={close} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'flex-end' }}>
        <Pressable onPress={() => {}} style={{ backgroundColor: t.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22 }}>
          <SafeAreaView edges={['bottom']} style={{ padding: 18, gap: 14 }}>
            <Text style={{ color: t.text, fontSize: 20, fontWeight: '700' }}>Group call</Text>
            {link && !editing ? (
              <>
                <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>Opens {client.circle.name}’s call in WhatsApp. Everyone with the link can join from there.</Text>
                <Button
                  variant="primary"
                  title="Join the group call"
                  onPress={() => {
                    close();
                    void openGroupCallLink(link).then(showOutcome);
                  }}
                />
                {admin ? (
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <Button small title="Change link" onPress={() => setChanging(true)} style={{ flex: 1 }} />
                    <Button small variant="danger" title="Remove link" loading={busy} onPress={() => void save('')} style={{ flex: 1 }} />
                  </View>
                ) : null}
              </>
            ) : editing ? (
              <>
                <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>
                  WhatsApp can’t start a group call from a link by itself, so make one there once: Calls tab → Create call link → choose video or voice → copy it, then paste it here. It stays the same for every call.
                </Text>
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                  <TextInput
                    value={draft}
                    onChangeText={(v) => {
                      setDraft(v);
                      setProblem(null);
                    }}
                    placeholder="https://call.whatsapp.com/video/…"
                    placeholderTextColor={t.muted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    accessibilityLabel="WhatsApp call link"
                    style={{ flex: 1, color: t.text, fontSize: 15, minHeight: 44, borderBottomWidth: 1, borderBottomColor: problem ? t.danger : t.line }}
                  />
                  <Button small title="Paste" onPress={() => void paste()} />
                </View>
                {problem ? <Text style={{ color: t.danger, fontSize: 14 }}>{problem}</Text> : null}
                <Button variant="primary" title="Save link" loading={busy} disabled={!draft.trim()} onPress={() => void save(draft.trim())} />
                <Text style={{ color: t.muted, fontSize: 12 }}>Saved encrypted, like the circle’s name: only your circle can read it.</Text>
              </>
            ) : (
              <Text style={{ color: t.muted, fontSize: 15, lineHeight: 21 }}>No group call link is saved yet. Ask a circle admin to add one: long-press Group call.</Text>
            )}
            {inApp ? (
              <Button
                title="Start an in-app call room"
                onPress={() => {
                  close();
                  inApp.startGroup(client);
                }}
              />
            ) : null}
          </SafeAreaView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
