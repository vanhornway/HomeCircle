import { useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { CircleClient } from '@homecircle/core';
import { Button } from './ui';
import { errorText } from '../lib/circle';
import { inAppCalls } from '../lib/inAppCalls';
import { joinGroupCall } from '../lib/groupCalls';
import { callLinkFrom } from '../lib/whatsappCore';
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
  const on = client.activeGroupCall();

  const close = () => {
    setDraft('');
    setProblem(null);
    setChanging(false);
    onClose();
  };

  // Whatever was copied or typed: the link is built from the code in it.
  const save = async (typed: string) => {
    const value = typed ? callLinkFrom(typed) : '';
    if (value === null) {
      setProblem('I can’t find a WhatsApp call link in that. In WhatsApp: Calls → Create call link → Copy link, then tap Paste again.');
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

  // One tap: take the link from the clipboard and save it.
  const pasteAndSave = async () => {
    const text = (await Clipboard.getStringAsync().catch(() => '')).trim();
    if (!text) setProblem('Nothing copied yet. In WhatsApp: Calls → Create call link → Copy link, then come back and tap Paste.');
    else await save(text);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={close} style={{ flex: 1, backgroundColor: t.scrim, justifyContent: 'flex-end' }}>
        <Pressable accessible={false} onPress={() => {}} style={{ backgroundColor: t.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22 }}>
          <SafeAreaView edges={['bottom']} style={{ padding: 18, gap: 14 }}>
            <Text style={{ color: t.text, fontSize: 20, fontWeight: '700' }}>Group call</Text>
            {link && !editing ? (
              <>
                <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>
                  {on
                    ? `${client.displayName(on.from)} started it. On it: ${on.joined.map((id) => client.displayName(id)).join(', ')}.`
                    : `Opens ${client.circle.name}’s call in WhatsApp, and tells everyone in the circle so they can join with one tap.`}
                </Text>
                <Button
                  variant="primary"
                  title={on ? 'Join the call' : 'Start group call'}
                  onPress={() => {
                    close();
                    void joinGroupCall(client, on?.id ?? null);
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
                  Make the call link once in WhatsApp (Calls → Create call link → Copy link). Then tap Paste: that’s all, I’ll set it up. It stays the same for every call.
                </Text>
                <Button variant="primary" title="Paste link and save" loading={busy} onPress={() => void pasteAndSave()} />
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                  <TextInput
                    value={draft}
                    onChangeText={(v) => {
                      setDraft(v);
                      setProblem(null);
                    }}
                    placeholder="Or type or paste it here"
                    placeholderTextColor={t.muted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    accessibilityLabel="WhatsApp call link"
                    style={{ flex: 1, color: t.text, fontSize: 15, minHeight: 44, borderBottomWidth: 1, borderBottomColor: problem ? t.danger : t.line }}
                  />
                  <Button small title="Save" loading={busy} disabled={!draft.trim()} onPress={() => void save(draft.trim())} />
                </View>
                {problem ? <Text style={{ color: t.danger, fontSize: 14 }}>{problem}</Text> : null}
                <Text style={{ color: t.muted, fontSize: 14 }}>Saved encrypted, like the circle’s name: only your circle can read it.</Text>
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
