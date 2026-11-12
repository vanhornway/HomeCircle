import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { P } from './ui';
import { GroupBody } from './SettingsKit';
import { useTheme } from '../theme';

/** How to let a tracker take settings from the home base: its key, to add in the Meshtastic app. */
export function KeyHelp({ keyText }: { keyText: string }) {
  const t = useTheme();
  const [copied, setCopied] = useState(false);
  return (
    <GroupBody>
      <P muted>
        In the Meshtastic app on your phone, connect to the tracker, open Settings → Security, and add this as an Admin key. Do it once per tracker.
      </P>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Copy the home base’s key"
        onPress={async () => {
          await Clipboard.setStringAsync(keyText);
          setCopied(true);
        }}
        style={{ padding: 12, borderRadius: 10, backgroundColor: t.surface2 }}
      >
        <Text selectable style={{ color: t.text, fontFamily: 'Menlo', fontSize: 14 }}>
          {keyText}
        </Text>
        <Text style={{ color: t.brand, fontSize: 14, fontWeight: '600', marginTop: 6 }}>{copied ? 'Copied' : 'Tap to copy'}</Text>
      </Pressable>
    </GroupBody>
  );
}
