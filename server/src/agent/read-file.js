// What's in a file someone sent the agent: its text (PDF, Word, a sheet,
// plain text), or the image itself for the AI to read (a photo, a scan).
// Text is read here so names can be swapped out before the AI sees it; an
// image can't be, so it goes as it is.
import { strFromU8, unzipSync } from 'fflate';
import { isPdf, pdfText } from './pdf.js';

const MAX_CHARS = 60_000;
const MAX_ROWS = 400;
const IMAGE_TYPES = { 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/png': 'image/png', 'image/webp': 'image/webp', 'image/gif': 'image/gif' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ext = (name) => String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
const sniffImage = (b) =>
  b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b.subarray(0, 4).toString() === 'GIF8' ? 'image/gif' : b.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
const unxml = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
const cap = (text) => ({ text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS });

/**
 * { kind: 'image', mime, data } (base64) for a photo, { kind: 'pdf', data }
 * for a scanned PDF (no text in it), or { kind: 'text', text, what,
 * truncated } for everything else. Throws an Error with what to do instead.
 */
export async function readFile(bytes, { name = '', mime = '' } = {}) {
  const buf = Buffer.from(bytes);
  const e = ext(name);
  const image = sniffImage(buf) ?? IMAGE_TYPES[String(mime).toLowerCase()] ?? null;
  if (image && sniffImage(buf)) {
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('That photo is too big to read (over 5 MB). Send a smaller one.');
    return { kind: 'image', mime: image, data: buf.toString('base64') };
  }
  if (/heic|heif/.test(mime) || ['heic', 'heif'].includes(e)) throw new Error('HEIC photos can’t be read yet. Send it as a JPEG (the app does this for you).');
  if (isPdf(buf, mime)) {
    const doc = await pdfText(buf);
    if (doc.text.replace(/--- page \d+ ---/g, '').trim().length < 40) return { kind: 'pdf', data: buf.toString('base64') };
    return { kind: 'text', what: 'a PDF', text: doc.text, truncated: doc.truncated };
  }
  if (e === 'docx' || /wordprocessingml/.test(mime)) return { kind: 'text', what: 'a Word document', ...cap(docxText(buf)) };
  if (e === 'xlsx' || /spreadsheetml/.test(mime)) return { kind: 'text', what: 'a spreadsheet', ...cap(xlsxText(buf)) };
  if (['csv', 'tsv'].includes(e) || /text\/(csv|tab-separated)/.test(mime)) return { kind: 'text', what: 'a spreadsheet', ...cap(rowsCap(buf.toString('utf8'))) };
  if (['txt', 'md', 'markdown', 'text'].includes(e) || /^text\//.test(mime)) return { kind: 'text', what: 'a text file', ...cap(buf.toString('utf8')) };
  if (['doc', 'xls', 'ppt', 'pptx', 'pages', 'numbers', 'key'].includes(e)) throw new Error(`I can’t read .${e} files. Save it as a PDF, .docx or .xlsx and send it again.`);
  throw new Error('I can’t read that kind of file. Send a photo, a PDF, a Word document (.docx), a spreadsheet (.xlsx or .csv) or a text file.');
}

function unzip(buf) {
  try {
    return unzipSync(new Uint8Array(buf));
  } catch {
    throw new Error('That file couldn’t be opened (it may be damaged)');
  }
}

/** A Word document's paragraphs and table cells, one line each. */
export function docxText(buf) {
  const doc = unzip(buf)['word/document.xml'];
  if (!doc) throw new Error('That isn’t a Word document I can read');
  const xml = strFromU8(doc);
  return unxml(xml.replace(/<w:tab\/>/g, '\t').replace(/<\/w:tc>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<w:br\/>/g, '\n'))
    .replace(/\t+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Every sheet of a workbook as rows of cells separated by " | ". */
export function xlsxText(buf) {
  const files = unzip(buf);
  const shared = files['xl/sharedStrings.xml'] ? [...strFromU8(files['xl/sharedStrings.xml']).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml(m[1])) : [];
  const names = files['xl/workbook.xml'] ? [...strFromU8(files['xl/workbook.xml']).matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => unxml(m[1])) : [];
  const sheets = Object.keys(files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!sheets.length) throw new Error('That isn’t a spreadsheet I can read');
  const out = [];
  for (const [i, p] of sheets.entries()) {
    const rows = [];
    for (const r of strFromU8(files[p]).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(([, attrs, inner = '']) => {
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
        return /\bt="s"/.test(attrs) ? (shared[Number(v)] ?? '') : unxml(v);
      });
      if (cells.some((c) => c.trim())) rows.push(cells.join(' | '));
      if (rows.length >= MAX_ROWS) break;
    }
    out.push(`--- sheet ${names[i] ?? i + 1} ---`, ...rows);
  }
  return out.join('\n');
}

const rowsCap = (text) => text.split(/\r?\n/).slice(0, MAX_ROWS).join('\n');
