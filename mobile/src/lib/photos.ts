// Members' photos on this phone: picked and cropped square, then encrypted
// and uploaded by the client (packages/core); downloaded photos are
// decrypted once and kept in the app's cache, by file id, so tiles and
// avatars show them without downloading again.
import { useEffect, useState } from 'react';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import type { CircleClient, PhotoRef } from '@homecircle/core';

const SIZE = 512;
const dir = new Directory(Paths.cache, 'photos');

/** A square photo from the camera or the gallery (the phone shows the crop), as JPEG bytes; null if cancelled. */
export async function pickSquarePhoto(from: 'camera' | 'library'): Promise<Uint8Array | null> {
  if (from === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error('HomeCircle needs the camera for that. You can allow it in the phone’s settings.');
  }
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 };
  const res = from === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  const a = res.canceled ? null : res.assets?.[0];
  if (!a) return null;
  const image = await ImageManipulator.manipulate(a.uri).resize({ width: SIZE, height: SIZE }).renderAsync();
  const saved = await image.saveAsync({ compress: 0.8, format: SaveFormat.JPEG });
  return new File(saved.uri).bytes();
}

const inFlight = new Map<string, Promise<string>>();

/** A photo as a file on this phone (downloaded and decrypted once). */
export function photoUri(client: CircleClient, ref: PhotoRef): Promise<string> {
  const file = new File(dir, `${ref.id}.jpg`);
  if (file.exists) return Promise.resolve(file.uri);
  if (!inFlight.has(ref.id)) {
    inFlight.set(
      ref.id,
      client
        .photoBytes(ref)
        .then((bytes) => {
          if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
          file.create({ overwrite: true });
          file.write(bytes);
          return file.uri;
        })
        .finally(() => inFlight.delete(ref.id)),
    );
  }
  return inFlight.get(ref.id)!;
}

/** The photo's file on this phone once it's ready (null meanwhile, or with no photo). */
export function usePhotoUri(client: CircleClient | null | undefined, ref: PhotoRef | null | undefined): string | null {
  const [uri, setUri] = useState<{ id: string; uri: string } | null>(null);
  useEffect(() => {
    if (!client || !ref) return;
    let live = true;
    photoUri(client, ref)
      .then((u) => live && setUri({ id: ref.id, uri: u }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, ref?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return ref && uri?.id === ref.id ? uri.uri : null;
}
