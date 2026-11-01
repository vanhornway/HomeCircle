import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { closeSheet, currentSheet, subscribeSheet, type SheetButton, type SheetRequest } from '../lib/sheet';
import { useTheme } from '../theme';

/**
 * Where `showSheet` / `confirm` (lib/sheet.ts) appear: a bottom sheet with a
 * title, one line, a main button and Cancel. Mounted once, in the root layout.
 */
export function ConfirmHost() {
  const t = useTheme();
  const [req, setReq] = useState<SheetRequest | undefined>(currentSheet);
  useEffect(() => {
    const sync = () => setReq(currentSheet());
    sync();
    return subscribeSheet(sync);
  }, []);
  if (!req) return null;

  const cancel = req.buttons.find((b) => b.style === 'cancel');
  const actions = req.buttons.filter((b) => b.style !== 'cancel');
  // The sheet closes first; what the button does runs once it's gone.
  const press = (b: SheetButton) => closeSheet(b);
  return (
    <Modal key={req.id} visible transparent animationType="slide" onRequestClose={() => closeSheet()}>
      <Pressable accessibilityLabel="Close" onPress={() => closeSheet()} style={{ flex: 1, backgroundColor: t.scrim, justifyContent: 'flex-end' }}>
        <Pressable onPress={() => {}} accessible={false} style={{ backgroundColor: t.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '85%' }}>
          <SafeAreaView edges={['bottom']}>
            <View style={{ paddingHorizontal: 20, paddingTop: 10, paddingBottom: 16 }}>
              <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: t.line, marginBottom: 14 }} />
              <Text accessibilityRole="header" style={{ color: t.text, fontSize: 19, fontWeight: '700' }}>
                {req.title}
              </Text>
              {req.message ? (
                <ScrollView style={{ flexGrow: 0, marginTop: 8 }}>
                  <Text style={{ color: t.text, fontSize: 16, lineHeight: 23 }}>{req.message}</Text>
                </ScrollView>
              ) : null}
              <View style={{ gap: 10, marginTop: 18 }}>
                {actions.map((b, i) => (
                  <SheetAction key={`${i}:${b.text}`} button={b} main={i === 0} onPress={() => press(b)} />
                ))}
                {cancel ? <SheetAction button={cancel} main={false} cancel onPress={() => press(cancel)} /> : null}
              </View>
            </View>
          </SafeAreaView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function SheetAction({ button, main, cancel, onPress }: { button: SheetButton; main: boolean; cancel?: boolean; onPress: () => void }) {
  const t = useTheme();
  const danger = button.style === 'destructive';
  const bg = main ? (danger ? t.danger : t.brand) : 'transparent';
  const fg = main ? (danger ? t.dangerInk : t.brandInk) : danger ? t.danger : cancel ? t.muted : t.brand;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 52,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 16,
        borderWidth: main || cancel ? 0 : 1,
        borderColor: danger ? t.danger : t.line,
        backgroundColor: pressed ? (main ? bg : t.surface2) : bg,
        opacity: pressed && main ? 0.85 : 1,
      })}
    >
      <Text style={{ color: fg, fontSize: 17, fontWeight: '700', textAlign: 'center' }}>{button.text}</Text>
    </Pressable>
  );
}
