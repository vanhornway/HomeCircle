import { useEffect, useState } from 'react';
import { Alert, Animated, Easing, Pressable, Text, TextInput, View } from 'react-native';
import type { CircleClient, PollState } from '@homecircle/core';
import { errorText } from '../lib/circle';
import { useTheme } from '../theme';

/** A poll in the chat: tap an option to vote; live bars, add, spin and close. */
export function PollCard({ client, pollId }: { client: CircleClient; pollId: string }) {
  const t = useTheme();
  const [now, setNow] = useState(() => Date.now());
  const s = client.pollState(pollId, now);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [spinning, setSpinning] = useState(false);
  const [spin] = useState(() => new Animated.Value(0));

  // Count down to the deadline (and close when it passes).
  useEffect(() => {
    if (!s?.closesAt || s.closed) return;
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [s?.closesAt, s?.closed]);

  if (!s) return null;
  const fail = (e: unknown) => Alert.alert('Poll', errorText(e));

  const tap = (optionId: string) => {
    if (s.closed) return;
    const mine = s.myVote.includes(optionId);
    const next = s.multi ? (mine ? s.myVote.filter((x) => x !== optionId) : [...s.myVote, optionId]) : mine ? [] : [optionId];
    client.vote(pollId, next).catch(fail);
  };

  const add = () => {
    const text = label.trim();
    if (!text) return;
    setLabel('');
    setAdding(false);
    client.suggestOption(pollId, text).catch(fail);
  };

  const spinIt = () => {
    setSpinning(true);
    spin.setValue(0);
    Animated.timing(spin, { toValue: 1, duration: 1400, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(() => {
      client
        .spinWheel(pollId)
        .catch(fail)
        .finally(() => setSpinning(false));
    });
  };

  const close = () =>
    Alert.alert('Close this poll?', 'No more votes after this. Everyone sees the result.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Close poll', onPress: () => client.closePoll(pollId).catch(fail) },
    ]);

  const minutesLeft = s.closesAt && !s.closed ? Math.max(1, Math.ceil((s.closesAt - now) / 60_000)) : null;
  const footer = [
    `${s.voters} of ${s.eligible} voted`,
    s.multi ? 'pick any' : null,
    s.closed ? 'closed' : minutesLeft != null ? (minutesLeft >= 60 ? `closes in ${Math.round(minutesLeft / 60)} h` : `closes in ${minutesLeft} min`) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const winnerIds = s.closed ? s.winners.map((w) => w.id) : [];
  const total = Math.max(1, s.voters);

  return (
    <View style={{ alignSelf: 'stretch', marginVertical: 6, backgroundColor: t.surface, borderRadius: 18, borderWidth: 1, borderColor: t.line, padding: 14, gap: 10 }}>
      <View>
        <Text style={{ color: t.muted, fontSize: 12, fontWeight: '700' }}>📊 POLL · {s.creatorName.toUpperCase()}</Text>
        <Text style={{ color: t.text, fontSize: 17, fontWeight: '700', marginTop: 2 }}>{s.question}</Text>
      </View>
      {s.options.map((o) => (
        <OptionRow
          key={o.id}
          option={o}
          share={o.votes / total}
          winner={winnerIds.includes(o.id)}
          disabled={s.closed}
          onPress={() => tap(o.id)}
        />
      ))}
      {s.everyoneVoted && !s.closed ? <Confetti text="🎉 Everyone voted!" /> : null}
      {s.spin ? (
        <Text style={{ color: t.text, fontSize: 14 }}>
          🎡 {s.spin.by} spun the wheel: {s.spin.option.emoji} {s.spin.option.label}
        </Text>
      ) : null}
      {adding ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <TextInput
            value={label}
            onChangeText={setLabel}
            autoFocus
            maxLength={60}
            placeholder="Another option"
            placeholderTextColor={t.muted}
            onSubmitEditing={add}
            style={{ flex: 1, color: t.text, fontSize: 15, minHeight: 40, borderBottomWidth: 1, borderBottomColor: t.line }}
          />
          <Chip label="Add" onPress={add} primary />
        </View>
      ) : null}
      <Text style={{ color: t.muted, fontSize: 13 }}>{footer}</Text>
      {!s.closed || (s.closed && s.winners.length > 1) ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {!s.closed && s.allowAdd && !adding && s.options.length < 12 ? <Chip label="+ Add option" onPress={() => setAdding(true)} /> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Spin the wheel"
            disabled={spinning}
            onPress={spinIt}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 12, borderRadius: 18, borderWidth: 1, borderColor: t.line, opacity: pressed || spinning ? 0.7 : 1 })}
          >
            <Animated.Text style={{ fontSize: 16, transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '1080deg'] }) }] }}>🎡</Animated.Text>
            <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{spinning ? 'Spinning…' : 'Spin'}</Text>
          </Pressable>
          {s.mine && !s.closed ? <Chip label="Close poll" onPress={close} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function OptionRow({ option, share, winner, disabled, onPress }: { option: PollState['options'][number]; share: number; winner: boolean; disabled: boolean; onPress: () => void }) {
  const t = useTheme();
  const [width] = useState(() => new Animated.Value(share));
  useEffect(() => {
    Animated.spring(width, { toValue: share, useNativeDriver: false, friction: 7 }).start();
  }, [share, width]);
  return (
    <Pressable
      accessibilityRole={disabled ? 'text' : 'button'}
      accessibilityState={{ selected: option.mine }}
      accessibilityLabel={`${option.label}, ${option.votes} ${option.votes === 1 ? 'vote' : 'votes'}${option.mine ? ', your vote' : ''}`}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}
    >
      <View style={{ minHeight: 46, borderRadius: 12, borderWidth: option.mine ? 2 : 1, borderColor: option.mine ? t.brand : t.line, overflow: 'hidden', justifyContent: 'center' }}>
        <Animated.View
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            backgroundColor: t.brandSoft,
            width: width.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
          }}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 }}>
          {winner ? <Text style={{ fontSize: 18 }}>🏆</Text> : null}
          {option.emoji ? <Text style={{ fontSize: 18 }}>{option.emoji}</Text> : null}
          <Text style={{ flex: 1, color: t.text, fontSize: 15, fontWeight: option.mine ? '700' : '500' }} numberOfLines={2}>
            {option.label}
          </Text>
          {option.mine ? <Text style={{ color: t.brand, fontWeight: '700' }}>✓</Text> : null}
          <Text style={{ color: t.muted, fontSize: 14, fontWeight: '600', minWidth: 18, textAlign: 'right' }}>{option.votes}</Text>
        </View>
      </View>
      {option.voters.length ? (
        <Text style={{ color: t.muted, fontSize: 12, marginTop: 2, marginLeft: 4 }} numberOfLines={1}>
          {option.voters.join(', ')}
        </Text>
      ) : null}
    </Pressable>
  );
}

function Chip({ label, onPress, primary }: { label: string; onPress: () => void; primary?: boolean }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 36,
        paddingHorizontal: 12,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: primary ? t.brand : t.line,
        backgroundColor: primary ? t.brand : 'transparent',
        justifyContent: 'center',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color: primary ? t.brandInk : t.text, fontSize: 14, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

const BURST = ['🎉', '✨', '🎊', '🥳', '✨', '🎉', '🎊', '✨'];

/** "Everyone voted!" with a small burst of confetti when it appears. */
function Confetti({ text }: { text: string }) {
  const t = useTheme();
  const [go] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(go, { toValue: 1, duration: 1200, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [go]);
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', minHeight: 36 }}>
      {BURST.map((e, i) => {
        const angle = (i / BURST.length) * Math.PI * 2;
        return (
          <Animated.Text
            key={i}
            style={{
              position: 'absolute',
              fontSize: 16,
              opacity: go.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 1, 0] }),
              transform: [
                { translateX: go.interpolate({ inputRange: [0, 1], outputRange: [0, Math.cos(angle) * 90] }) },
                { translateY: go.interpolate({ inputRange: [0, 1], outputRange: [0, Math.sin(angle) * 30 - 10] }) },
              ],
            }}
          >
            {e}
          </Animated.Text>
        );
      })}
      <Text style={{ color: t.brand, fontSize: 15, fontWeight: '700' }}>{text}</Text>
    </View>
  );
}
