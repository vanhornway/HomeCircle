// The code a new server's first page shows: https://<server>/start#t=<ticket>.
// The ticket sits after the #, so it never reaches the server's logs.

export function parseSetupLink(value: string): { server: string; ticket: string } | null {
  const m = value.trim().match(/^(https?:\/\/[^/?#\s]+)\/start#t=([0-9A-Za-z-]{6,32})$/);
  return m ? { server: m[1], ticket: m[2] } : null;
}
