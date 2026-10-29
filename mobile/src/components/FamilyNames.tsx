import { useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import type { CircleClient, Gender } from '@homecircle/core';
import { Button } from './ui';
import { errorText } from '../lib/circle';
import { useTheme } from '../theme';

/** Quick picks for what someone calls a person (PRD A2). */
export const FAMILY_NAME_CHIPS = ['Ammi', 'Abbu', 'Nani', 'Nana', 'Dadi', 'Dada', 'Grandma', 'Grandpa', 'Gran', 'Gramps', 'Mom', 'Dad'];

/** Small pills to pick one value; the picked one is filled. */
export function Chips<T extends string>({ options, value, onPick, label }: { options: { value: T; label: string }[]; value: T | null; onPick: (v: T) => void; label?: string }) {
  const t = useTheme();
  return (
    <View accessibilityLabel={label} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            onPress={() => onPick(o.value)}
            style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: on ? t.brand : t.line, backgroundColor: on ? t.brandSoft : t.surface }}
          >
            <Text style={{ color: on ? t.brand : t.text, fontWeight: on ? '700' : '500', fontSize: 14 }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * What `callerId` calls `memberId`: quick chips plus free text, saved as a
 * sealed family name. Either of them, or an admin, can change it.
 */
export function FamilyNameEditor({ client, callerId, memberId, chips = FAMILY_NAME_CHIPS, placeholder = 'Or type a name' }: { client: CircleClient; callerId: string; memberId: string; chips?: string[]; placeholder?: string }) {
  const t = useTheme();
  const saved = client.familyName(callerId, memberId) ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? saved;
  const save = (name: string) => {
    setSaving(true);
    client
      .setFamilyName(callerId, memberId, { name })
      .then(() => setDraft(null))
      .catch((e) => Alert.alert('Couldn’t save', errorText(e)))
      .finally(() => setSaving(false));
  };
  return (
    <View style={{ gap: 10 }}>
      {chips.length ? <Chips options={chips.map((c) => ({ value: c, label: c }))} value={chips.includes(saved) ? saved : null} onPick={(c) => save(c === saved ? '' : c)} /> : null}
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <TextInput
          value={value}
          onChangeText={setDraft}
          maxLength={40}
          placeholder={placeholder}
          placeholderTextColor={t.muted}
          style={{ flex: 1, color: t.text, fontSize: 17, minHeight: 44, borderBottomWidth: 1, borderBottomColor: t.line }}
        />
        <Button small variant="primary" title={value.trim() ? 'Save' : 'Clear'} loading={saving} disabled={value === saved} onPress={() => save(value)} />
      </View>
    </View>
  );
}

/** He / she, for languages whose verbs change with the person. */
export function GenderChips({ value, onPick }: { value: Gender | null; onPick: (g: Gender) => void }) {
  return (
    <Chips
      label="He or she"
      options={[
        { value: 'f', label: 'She / her' },
        { value: 'm', label: 'He / him' },
      ]}
      value={value}
      onPick={onPick}
    />
  );
}
