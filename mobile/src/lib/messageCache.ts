// Where each circle keeps the messages it already opened, between launches:
// one file per circle in the app's own documents folder (only this app can
// read it, like the keys). A cold start then opens only what's new, instead
// of decrypting and checking the whole history again, which takes minutes on
// a phone once a circle is busy.
import { Directory, File, Paths } from 'expo-file-system';

const dir = new Directory(Paths.document, 'messages');
const fileFor = (key: string) => new File(dir, `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

export const messageCache = {
  async getItem(key: string): Promise<string | null> {
    try {
      const f = fileFor(key);
      return f.exists ? await f.text() : null;
    } catch {
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    // Written beside it and moved into place: an app closed in the middle of
    // a save (it is several MB) leaves the last whole copy, not a cut-off one
    // that would be thrown away and fetched all over again.
    const tmp = new File(dir, `${fileFor(key).name}.tmp`);
    if (tmp.exists) tmp.delete();
    await tmp.write(value);
    tmp.move(fileFor(key), { overwrite: true });
  },
  async removeItem(key: string): Promise<void> {
    try {
      const f = fileFor(key);
      if (f.exists) f.delete();
    } catch {
      // already gone
    }
  },
};
