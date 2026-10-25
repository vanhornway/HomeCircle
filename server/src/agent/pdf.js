// The text of a PDF (a school calendar, a schedule), read on this server so
// names can be swapped out before any of it reaches the AI provider.
import { extractText, getDocumentProxy } from 'unpdf';

const MAX_PAGES = 30;
const MAX_CHARS = 60_000;

export const isPdf = (bytes, type = '') => /pdf/i.test(type) || bytes.subarray(0, 5).toString() === '%PDF-';

/**
 * { text, pages, truncated }: the text page by page ("--- page 2 ---"), the
 * first 30 pages and 60,000 characters at most. Throws if it isn't a PDF.
 */
export async function pdfText(bytes) {
  let doc;
  try {
    doc = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  } catch {
    throw new Error('That PDF couldn’t be opened (damaged, or password-protected)');
  }
  try {
    const pages = doc.numPages;
    const { text } = await extractText(doc, { mergePages: false });
    let out = '';
    let truncated = pages > MAX_PAGES;
    for (const [i, page] of text.slice(0, MAX_PAGES).entries()) {
      const clean = page.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      if (!clean) continue;
      out += `--- page ${i + 1} ---\n${clean}\n`;
      if (out.length > MAX_CHARS) {
        out = out.slice(0, MAX_CHARS);
        truncated = true;
        break;
      }
    }
    return { text: out.trim(), pages, truncated };
  } finally {
    await doc.destroy?.();
  }
}

/** A small PDF with one line of text per entry, one page per list (for tests). */
export function makePdf(pagesOfLines) {
  const objs = [];
  const add = (s) => objs.push(s) && objs.length;
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = objs.length + 1 + pagesOfLines.length * 2;
  const kids = [];
  for (const lines of pagesOfLines) {
    const stream = `BT /F1 12 Tf 14 TL 50 780 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = Buffer.byteLength(out);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
