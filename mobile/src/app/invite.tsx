import { useEffect, useState } from 'react';
import { ActivityIndicator, Share, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { Invite } from '@homecircle/core';
import { QRCode } from '../components/QRCode';
import { Button, ErrorText, LockNote, P, Screen } from '../components/ui';
import { errorText, getClient } from '../lib/circle';
import { useTheme } from '../theme';

export default function InviteScreen() {
  const t = useTheme();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () =>
    getClient()
      .createInvite({ hours: 48 })
      .then(setInvite)
      .catch((e) => setError(errorText(e)));
  const create = () => {
    setError(null);
    setInvite(null);
    setCopied(false);
    load();
  };
  useEffect(() => {
    load();
  }, []);

  return (
    <Screen>
      <P muted style={{ marginBottom: 18 }}>
        Have them open HomeCircle, tap “Join my family”, and scan this code. Or send the link privately.
      </P>
      <View style={{ alignItems: 'center', padding: 16, backgroundColor: '#fff', borderRadius: 20, alignSelf: 'center', minWidth: 252, minHeight: 252, justifyContent: 'center' }}>
        {invite ? <QRCode value={invite.link} size={220} /> : <ActivityIndicator color={t.brand} />}
      </View>
      {invite ? (
        <>
          <Text style={{ color: t.muted, textAlign: 'center', marginTop: 12, fontSize: 13 }}>
            Works once · expires {new Date(invite.expiresAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
          </Text>
          <View style={{ gap: 10, marginTop: 20 }}>
            <Button title="Share link" variant="primary" onPress={() => Share.share({ message: `Join our family on HomeCircle: ${invite.link}` })} />
            <Button
              title={copied ? 'Copied' : 'Copy link'}
              onPress={async () => {
                await Clipboard.setStringAsync(invite.link);
                setCopied(true);
              }}
            />
            <Button title="New code" variant="ghost" onPress={create} />
          </View>
        </>
      ) : null}
      <ErrorText>{error}</ErrorText>
      <LockNote>The secret part of this link never reaches your server. Anyone who has it can join until it’s used, so share it only with family.</LockNote>
    </Screen>
  );
}
