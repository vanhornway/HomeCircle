import { useCallback, useState } from 'react';
import { Alert, Modal, Pressable, Switch, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { CircleClient } from '@homecircle/core';
import { Button, Card, SectionTitle } from './ui';
import { updateSettings, type Settings } from '../lib/storage';
import { clearVisits, editPlace, kindName, KIND_EMOJI, myPlaces, shareMyPlaces, type MyPlace } from '../lib/visits';
import { useTheme } from '../theme';

/** Your most visited places: share them or not, rename or hide each one. */
export function FrequentSettings({ clients, settings, onChange }: { clients: CircleClient[]; settings: Settings | null; onChange: (s: Settings) => void }) {
  const t = useTheme();
  const [places, setPlaces] = useState<MyPlace[] | null>(null);
  const [renaming, setRenaming] = useState<MyPlace | null>(null);
  const [name, setName] = useState('');

  const load = useCallback(() => {
    myPlaces()
      .then(setPlaces)
      .catch(() => setPlaces([]));
  }, []);
  useFocusEffect(load);

  // Any change goes out to your circles right away (not in 6 hours).
  const changed = async () => {
    load();
    await shareMyPlaces(clients, { force: true }).catch(() => {});
  };

  const sharing = settings?.shareFrequent ?? true;
  return (
    <>
      <SectionTitle>Most visited places</SectionTitle>
      <Card style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Share my most visited places</Text>
            <Text style={{ color: t.muted, fontSize: 13, marginTop: 2 }}>
              {sharing
                ? 'Circles that see your exact location see where you go most. Your history stays on this phone.'
                : 'No one sees your most visited places.'}
            </Text>
          </View>
          <Switch
            value={sharing}
            onValueChange={(v) =>
              updateSettings({ shareFrequent: v })
                .then(onChange)
                .then(changed)
            }
            trackColor={{ true: t.brand }}
          />
        </View>

        {places === null ? null : places.length ? (
          places.map((p) => (
            <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, opacity: p.hidden ? 0.5 : 1 }}>
              <Text style={{ fontSize: 20 }}>{KIND_EMOJI[p.kind]}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
                  {p.name}
                </Text>
                <Text style={{ color: t.muted, fontSize: 12 }}>
                  {kindName(p.kind)} · {p.hours < 1 ? `${Math.round(p.hours * 60)} min` : `${Math.round(p.hours)} h`} · {p.visits}{' '}
                  {p.visits === 1 ? 'visit' : 'visits'}
                  {p.hidden ? ' · hidden' : ''}
                </Text>
              </View>
              <Button
                small
                variant="ghost"
                title="Rename"
                onPress={() => {
                  setName(p.named ? p.name : '');
                  setRenaming(p);
                }}
              />
              <Button small variant="ghost" title={p.hidden ? 'Show' : 'Hide'} onPress={() => editPlace(p, { hidden: !p.hidden }).then(changed)} />
            </View>
          ))
        ) : (
          <Text style={{ color: t.muted, fontSize: 13 }}>Your most visited places appear here after a few days of sharing your location.</Text>
        )}
        <Text style={{ color: t.muted, fontSize: 13 }}>
          Names are a first guess from where you spend nights and weekdays, and from your phone’s map lookup. Rename any that are wrong.
        </Text>
        <Button
          small
          variant="danger"
          title="Forget my history"
          onPress={() =>
            Alert.alert('Forget your history?', 'This phone forgets where you’ve been, and your circles stop seeing your most visited places.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Forget', style: 'destructive', onPress: () => clearVisits().then(changed) },
            ])
          }
        />
      </Card>

      <Modal visible={!!renaming} transparent animationType="fade" onRequestClose={() => setRenaming(null)}>
        <Pressable onPress={() => setRenaming(null)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', paddingHorizontal: 16 }}>
          <Pressable onPress={() => {}} style={{ backgroundColor: t.surface, borderRadius: 20, padding: 20, gap: 12 }}>
            <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>Name this place</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              autoFocus
              maxLength={40}
              placeholder={renaming?.name || 'e.g. Grandma’s'}
              placeholderTextColor={t.muted}
              style={{ color: t.text, fontSize: 16, minHeight: 44, borderBottomWidth: 1, borderBottomColor: t.line }}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {renaming?.named ? (
                <Button
                  small
                  title="Use the guess"
                  style={{ flex: 1 }}
                  onPress={() => {
                    const p = renaming;
                    setRenaming(null);
                    editPlace(p, { name: null }).then(changed);
                  }}
                />
              ) : null}
              <Button
                small
                variant="primary"
                title="Save"
                disabled={!name.trim()}
                style={{ flex: 1 }}
                onPress={() => {
                  const p = renaming!;
                  setRenaming(null);
                  editPlace(p, { name }).then(changed);
                }}
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
