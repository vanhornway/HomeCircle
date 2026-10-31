// Small helpers for the SDP a call sends. Plain functions, no React Native:
// tested with Node (callSdp.test.ts).

/** What a voice call asks of Opus: about 32 kbit/s mono, forward error correction on, DTX off. */
export const OPUS_VOICE_PARAMS: Record<string, string> = {
  minptime: '20',
  useinbandfec: '1',
  maxaveragebitrate: '32000',
  stereo: '0',
  'sprop-stereo': '0',
  usedtx: '0',
  cbr: '0',
};

/**
 * Set the Opus parameters of a voice call in an SDP: keeps whatever else the
 * Opus fmtp line says, replaces the keys above, adds the line if there isn't
 * one. The payload type comes from the SDP (it is not always 111). An SDP
 * without Opus is returned unchanged.
 */
export function tuneOpusSdp(sdp: string, params: Record<string, string> = OPUS_VOICE_PARAMS): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const out: string[] = [];
  const done = new Set<string>();
  const opus = new Set<string>();
  for (const l of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(l);
    if (m) opus.add(m[1]);
  }
  if (!opus.size) return sdp;
  const format = (existing: string) => {
    const kv = new Map<string, string>();
    for (const part of existing.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k) kv.set(k, v.join('='));
    }
    for (const [k, v] of Object.entries(params)) kv.set(k, v);
    return [...kv].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';');
  };
  for (const l of lines) {
    const f = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (f && opus.has(f[1])) {
      out.push(`a=fmtp:${f[1]} ${format(f[2])}`);
      done.add(f[1]);
    } else out.push(l);
  }
  // Opus without an fmtp line: add one right after its rtpmap.
  const withLines: string[] = [];
  for (const l of out) {
    withLines.push(l);
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(l);
    if (m && !done.has(m[1])) withLines.push(`a=fmtp:${m[1]} ${format('')}`);
  }
  return withLines.join(eol);
}

/** The DTLS fingerprints in an SDP ("sha-256 AB:CD…"), lower-cased and sorted, without duplicates. */
export function fingerprintsOf(sdp: string): string[] {
  const set = new Set<string>();
  for (const l of sdp.split(/\r?\n/)) {
    const m = /^a=fingerprint:(\S+) (\S+)/i.exec(l);
    if (m) set.add(`${m[1].toLowerCase()} ${m[2].toUpperCase()}`);
  }
  return [...set].sort();
}
