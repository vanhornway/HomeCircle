import { Alert, Image, Pressable, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import type { CircleClient, Member } from '@homecircle/core';
import { Avatar } from '../components/ui';
import { PhotoButtons } from '../components/PhotoPicker';
import { usePhotoUri } from '../lib/photos';
import { GroupBody, SettingsGroup, SettingsPage } from '../components/SettingsKit';
import { FamilyNameEditor, GenderChips } from '../components/FamilyNames';
import { errorText } from '../lib/circle';
import { useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

const EVENTS = ['members', 'records'] as const;

/**
 * People on her tiles (design 18): their order on her page, the name she
 * knows each one by (in Urdu, shown on a tile with no photo), and each
 * one's he/she for the Urdu she hears.
 */
export default function ElderTiles() {
  const t = useTheme();
  const { member } = useLocalSearchParams<{ member: string }>();
  const client = useCircle(EVENTS);
  const her = client.members.get(member);
  if (!her) return null;
  const order = client.memberRecord(member)?.tiles ?? [];
  const people = client
    .memberList()
    .filter((m) => m.id !== member)
    .sort((a, b) => (order.includes(a.id) ? order.indexOf(a.id) : order.length) - (order.includes(b.id) ? order.indexOf(b.id) : order.length));

  const move = (id: string, by: number) => {
    const ids = people.map((p) => p.id);
    const i = ids.indexOf(id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    client.setMemberRecord(member, { tiles: ids }).catch((e) => Alert.alert('Couldn’t save', errorText(e)));
  };
  const arrow = (label: string, on: boolean, onPress: () => void) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={!on} onPress={onPress} style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: t.surface2, opacity: on ? 1 : 0.3 }}>
      <Text style={{ color: t.text, fontSize: 18 }}>{label === 'Move up' ? '↑' : '↓'}</Text>
    </Pressable>
  );

  return (
    <SettingsPage title="People on her tiles">
      <Text style={{ color: t.muted, fontSize: 13, lineHeight: 18, marginTop: 12, marginHorizontal: 4 }}>
        {her.name}’s page shows these people in this order. Each tile shows the person’s own photo (coming soon), or else the name below in large Urdu letters.
      </Text>
      {people.map((p, i) => (
        <SettingsGroup key={p.id}>
          <GroupBody>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <TilePreview client={client} herId={member} member={p} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{p.name}</Text>
                <Text style={{ color: t.muted, fontSize: 13 }}>Tile {i + 1}</Text>
              </View>
              {client.isAdmin ? arrow('Move up', i > 0, () => move(p.id, -1)) : null}
              {client.isAdmin ? arrow('Move down', i < people.length - 1, () => move(p.id, 1)) : null}
            </View>
            <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>Photo on her tile</Text>
            {p.photo ? (
              <Text style={{ color: t.muted, fontSize: 13 }}>Their own photo, from their app.</Text>
            ) : client.isAdmin && client.feature('photos') ? (
              <>
                <Text style={{ color: t.muted, fontSize: 13 }}>
                  {client.memberRecord(member)?.photos?.[p.id] ? 'Chosen by an admin. If they add their own photo, it replaces this one.' : 'No photo yet. Pick a close, bright photo of their face that she’ll recognize.'}
                </Text>
                <PhotoButtons has={!!client.memberRecord(member)?.photos?.[p.id]} onPhoto={(bytes) => client.setTilePhoto(member, p.id, bytes)} />
              </>
            ) : (
              <Text style={{ color: t.muted, fontSize: 13 }}>No photo yet.</Text>
            )}
            <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>What {her.name} calls them, in Urdu</Text>
            <FamilyNameEditor client={client} callerId={member} memberId={p.id} chips={[]} placeholder="e.g. عمیر" />
            <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>He or she</Text>
            {p.g ? (
              <Text style={{ color: t.muted, fontSize: 13 }}>{p.g === 'f' ? 'She' : 'He'}, set in their own profile.</Text>
            ) : (
              <GenderChips value={client.memberRecord(p.id)?.g ?? null} onPick={(g) => client.setMemberRecord(p.id, { g }).catch((e) => Alert.alert('Couldn’t save', errorText(e)))} />
            )}
          </GroupBody>
        </SettingsGroup>
      ))}
    </SettingsPage>
  );
}

/** How the tile looks on her phone: the photo cropped to the tile, else the name. */
function TilePreview({ client, herId, member }: { client: CircleClient; herId: string; member: Member }) {
  const uri = usePhotoUri(client, client.tilePhoto(herId, member.id));
  if (uri) return <Image source={{ uri }} accessibilityLabel={`${member.name}’s tile`} style={{ width: 56, height: 56, borderRadius: 14, borderWidth: 2, borderColor: '#1B1B1F' }} />;
  return <Avatar name={member.name} color={member.color} size={56} />;
}
