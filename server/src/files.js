// Files sent to a circle's agent (a photo, a document, a spreadsheet). They
// arrive encrypted on the phone with a key only the sender and the agent
// have; the server keeps the ciphertext in DATA_DIR/files and its size and
// owner in the database. A file nobody chose to keep is deleted after 7 days.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_FILE_BYTES = 16 * 1024 * 1024; // 15 MB of file, plus encryption
export const UNKEPT_DAYS = 7;
const ID = /^[A-Za-z0-9_-]{16,40}$/;

export function createFiles({ dataDir, store }) {
  const dir = join(dataDir, 'files');
  mkdirSync(dir, { recursive: true });
  const path = (id) => {
    if (!ID.test(id)) throw new Error('bad file id');
    return join(dir, id);
  };
  const remove = (id) => {
    rmSync(path(id), { force: true });
    store.deleteFileRow(id);
  };
  return {
    /** A member's photo is kept until it's replaced or they leave; anything else goes after 7 days unless kept. */
    save({ id, circleId, uploaderId, bytes, now, purpose = 'agent' }) {
      writeFileSync(path(id), bytes);
      store.insertFile({ id, circleId, uploaderId, size: bytes.length, now, purpose, expiresAt: purpose === 'photo' ? null : now + UNKEPT_DAYS * 86400_000 });
    },
    read: (id) => readFileSync(path(id)),
    remove,
    /** Everything in a circle (it was deleted). */
    removeCircle(circleId) {
      for (const id of store.circleFileIds(circleId)) remove(id);
    },
    /** Everything a circle's agent was sent or made (it was removed); members' photos stay. */
    removeAgentFiles(circleId) {
      for (const id of store.agentFileIds(circleId)) remove(id);
    },
    /** A member's photos (they left). */
    removePhotosBy(memberId) {
      for (const id of store.photoFileIdsBy(memberId)) remove(id);
    },
    /** Files past their 7 days that nobody kept. */
    prune(now) {
      for (const id of store.expiredFileIds(now)) remove(id);
    },
  };
}
