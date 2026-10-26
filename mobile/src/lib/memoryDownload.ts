// "Download memory": the helper zips what you can see of its memory as an
// Obsidian vault and leaves it on the server encrypted; this fetches each
// part, decrypts it here, and offers it to save or share (Files, Drive,
// email…).
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { CircleClient } from '@homecircle/core';

type Part = { id: string; key: string; name: string; size: number };
export type MemoryDownload = { parts: Part[]; notes: number; files: number; missing: string[] };

/** Fetch, decrypt and share each part of a memory download; answers what the helper said it put in. */
export async function downloadMemory(client: CircleClient): Promise<MemoryDownload> {
  // Kept files are read back and zipped on the server: give it time.
  const out = await client.agentRpc<MemoryDownload>('exportZip', {}, { timeoutMs: 180_000 });
  for (const part of out.parts) {
    const bytes = await client.openAgentFile(part);
    const file = new File(Paths.cache, part.name.replace(/[^\w .()-]+/g, '_'));
    if (file.exists) file.delete();
    file.create();
    await file.write(bytes);
    await Sharing.shareAsync(file.uri, { mimeType: 'application/zip', UTI: 'public.zip-archive', dialogTitle: part.name });
    file.delete();
  }
  return out;
}
