// The skin follows what the circle says. An admin's member record about
// this phone's person names a skin; across this phone's circles the most
// restricted one wins (Elderly Companion over Full), so an admin can switch
// her phone, or switch it back, from their own. A circle with no record says
// nothing, so a skin from the invite stays until a record arrives.
import type { CircleClient } from '@homecircle/core';
import { SKINS, currentSkin, isSkin, setSkin, type SkinId } from './index';

/** Look at the records and switch this phone's skin if they say so. */
export async function syncSkinFromRecords(clients: CircleClient[]) {
  const said = clients
    .map((c) => (c.account ? c.memberRecord(c.account.memberId)?.skin : null))
    .filter((s): s is SkinId => isSkin(s));
  if (!said.length) return;
  const skin = said.find((s) => SKINS[s].locked) ?? said[0];
  if (skin !== currentSkin()) await setSkin(skin);
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
