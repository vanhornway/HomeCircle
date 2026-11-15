// A tracker's journeys: the ways it went while it was "on the move", newest
// first. Tap one to see it on the map. From the person sheet: Journeys.
import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { Journey } from '@homecircle/core';
import { GroupBody, SettingsGroup, SettingsPage } from '../components/SettingsKit';
import { Button, ErrorText, P } from '../components/ui';
import { errorText } from '../lib/circle';
import { journeyEnd, journeyWhen, onTheMoveLine } from '../lib/journeys';
import { showSheet } from '../lib/sheet';
import { useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

export default function Journeys() {
  const t = useTheme();
  const { member } = useLocalSearchParams<{ member?: string }>();
  const client = useCircle(['members', 'journeys', 'places']);
  const name = member ? client.members.get(member)?.name : null;
  const open = member ? client.journeys.get(member) : undefined;
  const [list, setList] = useState<Journey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!member) return;
    client.journeyList(member).then(
      (l) => {
        setList(l);
        setError(null);
      },
      (e) => setError(errorText(e)),
    );
  }, [client, member]);
  // Again when one starts or ends.
  useEffect(load, [load, open?.id, open?.endedAt]);

  if (!member || !name) {
    return (
      <SettingsPage title="Journeys">
        <GroupBody>
          <P muted>That tracker isn’t in this circle any more.</P>
        </GroupBody>
      </SettingsPage>
    );
  }

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      load();
    } catch (e) {
      showSheet('Couldn’t do that', errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const show = (j: Journey) => router.navigate({ pathname: '/', params: { journey: j.id } });
  const home = client.journeyHome();

  return (
    <SettingsPage title={`${name}: journeys`}>
      <SettingsGroup
        title="On the move"
        footer={
          home
            ? `While it’s on the move, every position it sends is kept, so you can see the way it went. It ends by itself once it has left ${home.name} and is back. The last 10 are kept, for 90 days.`
            : 'While it’s on the move, every position it sends is kept, so you can see the way it went. Add a place called Home (or pin the home base) and it ends by itself once it’s back.'
        }
      >
        <GroupBody gap={10}>
          {open ? (
            <>
              <P>{onTheMoveLine(open)}</P>
              <Button title="Show its way on the map" variant="primary" onPress={() => show(open)} />
              <Button title="End the journey now" loading={busy} onPress={() => act(() => client.endJourney(open.id))} />
            </>
          ) : (
            <Button title={`${name} is on the move`} variant="primary" loading={busy} onPress={() => act(() => client.startJourney(member))} />
          )}
        </GroupBody>
      </SettingsGroup>
      <SettingsGroup title="Past journeys">
        {error ? (
          <GroupBody>
            <ErrorText>{error}</ErrorText>
          </GroupBody>
        ) : null}
        {list?.filter((j) => j.endedAt).length ? (
          list
            .filter((j) => j.endedAt)
            .map((j) => (
              <Pressable
                key={j.id}
                accessibilityRole="button"
                accessibilityHint="Shows it on the map"
                onPress={() => show(j)}
                onLongPress={() =>
                  showSheet('Delete this journey?', 'Its positions are deleted for everyone in the circle.', [
                    { text: 'Delete', style: 'destructive', onPress: () => void act(() => client.deleteJourney(j.id)) },
                    { text: 'Cancel', style: 'cancel' },
                  ])
                }
                style={({ pressed }) => ({ paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: 1, borderTopColor: t.line, backgroundColor: pressed ? t.surface2 : undefined })}
              >
                <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{journeyWhen(j)}</Text>
                <Text style={{ color: t.muted, fontSize: 14 }}>
                  {journeyEnd(j)} · {j.points} position{j.points === 1 ? '' : 's'}
                </Text>
              </Pressable>
            ))
        ) : (
          <View style={{ padding: 14 }}>
            <P muted>{list ? 'None yet.' : 'Loading…'}</P>
          </View>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
