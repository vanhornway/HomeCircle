// Picking something to send the circle's helper: a photo (camera or gallery)
// or a file (PDF, Word, a spreadsheet, text). Photos are made smaller and
// saved as JPEG first, so they upload fast and the helper can read them
// (HEIC included). The file is then encrypted for the helper by the client.
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

export type Picked = { bytes: Uint8Array; name: string; mime: string };

const MAX_EDGE = 1600;
const MAX_BYTES = 15 * 1024 * 1024;
export const DOCUMENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/comma-separated-values',
  'text/plain',
  'text/markdown',
  'image/*',
];

/** A photo at most 1600 px on its longest side, as JPEG bytes. */
async function asJpeg(uri: string): Promise<Uint8Array> {
  const first = await ImageManipulator.manipulate(uri).renderAsync();
  const long = Math.max(first.width, first.height);
  const image = long > MAX_EDGE ? await ImageManipulator.manipulate(uri).resize(first.width >= first.height ? { width: MAX_EDGE } : { height: MAX_EDGE }).renderAsync() : first;
  const saved = await image.saveAsync({ compress: 0.8, format: SaveFormat.JPEG });
  return new File(saved.uri).bytes();
}

const jpegName = (name: string | null | undefined) => `${(name || 'photo').replace(/\.[^.]+$/, '')}.jpg`;

/** A photo from the camera or the gallery, or null if they cancelled. */
export async function pickPhoto(from: 'camera' | 'library'): Promise<Picked | null> {
  if (from === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error('HomeCircle needs the camera for that. You can allow it in the phone’s settings.');
  }
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1 };
  const res = from === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  const a = res.canceled ? null : res.assets?.[0];
  if (!a) return null;
  return { bytes: await asJpeg(a.uri), name: jpegName(a.fileName), mime: 'image/jpeg' };
}

/** A document, sheet or image file, or null if they cancelled. */
export async function pickDocument(): Promise<Picked | null> {
  const res = await DocumentPicker.getDocumentAsync({ type: DOCUMENT_TYPES, copyToCacheDirectory: true, multiple: false });
  const a = res.canceled ? null : res.assets?.[0];
  if (!a) return null;
  if (a.size && a.size > MAX_BYTES) throw new Error('That file is too big (over 15 MB).');
  if (a.mimeType?.startsWith('image/')) return { bytes: await asJpeg(a.uri), name: jpegName(a.name), mime: 'image/jpeg' };
  const bytes = await new File(a.uri).bytes();
  if (bytes.length > MAX_BYTES) throw new Error('That file is too big (over 15 MB).');
  return { bytes, name: a.name, mime: a.mimeType ?? '' };
}
