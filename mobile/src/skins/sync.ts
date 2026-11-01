// The skin follows what the circle says. An admin's member record about
// this phone's person names a skin; across this phone's circles the most
// restricted one wins (Elderly Companion over Full), so an admin can switch
// her phone, or switch it back, from their own. A circle with no record says
// nothing, so a skin from the invite stays until a record arrives.
import type { CircleClient } from '@homecircle/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SKINS, currentSkin, isSkin, loadSkin, setSkin, type SkinId } from './index';
import { pickSkin } from './profile';

// What this phone last showed, kept so a push waking the app in the background
// (a fresh start of the JavaScript) still knows the profile changed.
const SEEN_KEY = 'homecircle.profileSeen';

/** The page this phone's person has in the circle that keeps it on the Elderly Companion. */
export function pageOf(clients: CircleClient[]): 'care' | 'grandkids' | null {
  for (const c of clients) {
    const rec = c.account ? c.memberRecord(c.account.memberId) : null;
    if (rec?.skin === 'elderly') return rec.page === 'grandkids' ? 'grandkids' : 'care';
  }
  return null;
}

/**
 * Look at the records and switch this phone's skin if they say so. True when
 * the skin or page changed since this was last looked at (the caller then
 * sends a location, which tells the admin the phone has followed).
 */
export async function syncSkinFromRecords(clients: CircleClient[]): Promise<boolean> {
  await loadSkin();
  const said = clients
    .map((c) => (c.account ? c.memberRecord(c.account.memberId)?.skin : null))
    .filter((s): s is SkinId => isSkin(s));
  const skin = pickSkin(said, (s) => SKINS[s].locked);
  if (skin && skin !== currentSkin()) await setSkin(skin);
  const key = `${currentSkin()}/${currentSkin() === 'elderly' ? (pageOf(clients) ?? 'care') : ''}`;
  const before = await AsyncStorage.getItem(SEEN_KEY).catch(() => null);
  if (before === key) return false;
  await AsyncStorage.setItem(SEEN_KEY, key).catch(() => {});
  return before !== null;
}

/**
 * An admin's phone: save a member record for each elder who joined with an
 * elder's invite and announced it, so her settings live in the circle.
 */
export async function recordNewElders(client: CircleClient) {
  if (!client.isAdmin) return;
  for (const e of client.unrecordedElders()) {
    await client.setMemberRecord(e.memberId, { skin: e.skin, page: e.page }).catch(() => {});
  }
}
