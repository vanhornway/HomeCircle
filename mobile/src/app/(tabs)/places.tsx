import { Alert, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Avatar, Button, Card, H1, Icon, P, Screen } from '../../components/ui';
import { useCircle } from '../../lib/useCircle';
import { errorText } from '../../lib/circle';
import { useTheme } from '../../theme';
import { CircleSwitcher } from '../../components/CircleSwitcher';

export default function Places() {
  const t = useTheme();
  const client = useCircle();
  const places = [...client.places.values()].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Screen>
      <H1 style={{ marginTop: 4 }}>Places</H1>
      <CircleSwitcher style={{ marginTop: 6 }} />
      <P muted style={{ marginTop: 10, marginBottom: 18 }}>
        Get an alert in chat when someone arrives at or leaves a place. Each phone detects this itself; the server never learns where your places are.
      </P>
      <Button title="Add a place" variant="primary" onPress={() => router.push('/add-place')} />
      <View style={{ marginTop: 18, gap: 10 }}>
        {places.map((p) => {
          const here = client.memberList().filter((m) => client.locations.get(m.id)?.placeId === p.id);
          return (
            <Card key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="place" color={t.brand} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontWeight: '700', fontSize: 16 }}>{p.name}</Text>
                <Text style={{ color: t.muted, fontSize: 14 }}>
                  {p.radius} m radius{here.length ? ` · ${here.map((m) => m.name).join(', ')} here` : ''}
                </Text>
              </View>
              {here.slice(0, 2).map((m) => (
                <Avatar key={m.id} name={m.name} color={m.color} size={28} />
              ))}
              <Pressable
                accessibilityLabel={`Delete ${p.name}`}
                onPress={() =>
                  Alert.alert(`Delete ${p.name}?`, 'Arrival alerts for this place will stop for everyone.', [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Delete',
                      style: 'destructive',
                      onPress: () => client.deletePlace(p.id).catch((e) => Alert.alert('Couldn’t delete', errorText(e))),
                    },
                  ])
                }
                hitSlop={10}
              >
                <Text style={{ color: t.danger, fontWeight: '600' }}>Delete</Text>
              </Pressable>
            </Card>
          );
        })}
        {!places.length ? <P muted>No places yet. Try Home, School or Work.</P> : null}
      </View>
    </Screen>
  );
}
