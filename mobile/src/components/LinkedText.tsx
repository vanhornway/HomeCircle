import { Linking, Text, type StyleProp, type TextStyle } from 'react-native';

// Web addresses in a message: http(s)://… or www.…, without the punctuation
// that usually ends a sentence after them.
const URL = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;
const TRAILING = /[.,;:!?)\]}'’”]+$/;

/** Split text into plain parts and links (exported for tests). */
export function splitLinks(text: string): { text: string; url?: string }[] {
  const parts: { text: string; url?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(URL)) {
    let link = m[0];
    const tail = link.match(TRAILING)?.[0] ?? '';
    // Keep a closing bracket that belongs to the address, as in Wikipedia links.
    const keep = tail.startsWith(')') && link.includes('(') ? 1 : 0;
    link = link.slice(0, link.length - tail.length + keep);
    if (m.index! > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: link, url: /^https?:/i.test(link) ? link : `https://${link}` });
    last = m.index! + link.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** Message text with its web addresses tappable (opened in the browser). */
export function LinkedText({ text, style, linkColor }: { text: string; style?: StyleProp<TextStyle>; linkColor: string }) {
  const parts = splitLinks(text);
  if (!parts.some((p) => p.url)) return <Text style={style}>{text}</Text>;
  return (
    <Text style={style}>
      {parts.map((p, i) =>
        p.url ? (
          <Text key={i} accessibilityRole="link" onPress={() => Linking.openURL(p.url!).catch(() => {})} style={{ color: linkColor, textDecorationLine: 'underline' }}>
            {p.text}
          </Text>
        ) : (
          p.text
        ),
      )}
    </Text>
  );
}
