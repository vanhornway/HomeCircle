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
    await fileFor(key).write(value);
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
