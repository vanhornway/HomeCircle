import { Alert, Pressable, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Avatar } from '../components/ui';
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
              <Avatar name={p.name} color={p.color} size={40} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{p.name}</Text>
                <Text style={{ color: t.muted, fontSize: 13 }}>Tile {i + 1}</Text>
              </View>
              {client.isAdmin ? arrow('Move up', i > 0, () => move(p.id, -1)) : null}
              {client.isAdmin ? arrow('Move down', i < people.length - 1, () => move(p.id, 1)) : null}
            </View>
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
