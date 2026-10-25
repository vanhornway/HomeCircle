// Reading files sent to the agent: photos go to the AI as they are; PDFs,
// Word documents, spreadsheets and text are read here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { readFile } from '../src/agent/read-file.js';
import { makePdf } from '../src/agent/pdf.js';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createFiles } from '../src/files.js';

const docx = (paragraphs) =>
  Buffer.from(
    zipSync({
      'word/document.xml': strToU8(
        `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p.replace(/&/g, '&amp;')}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`,
      ),
    }),
  );
const xlsx = (rows) =>
  Buffer.from(
    zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Team" sheetId="1"/></sheets></workbook>'),
      'xl/sharedStrings.xml': strToU8(`<sst>${rows.flat().filter((c) => typeof c === 'string').map((c) => `<si><t>${c}</t></si>`).join('')}</sst>`),
      'xl/worksheets/sheet1.xml': strToU8(
        (() => {
          let i = 0;
          return `<worksheet><sheetData>${rows.map((r) => `<row>${r.map((c) => (typeof c === 'string' ? `<c t="s"><v>${i++}</v></c>` : `<c><v>${c}</v></c>`)).join('')}</row>`).join('')}</sheetData></worksheet>`;
        })(),
      ),
    }),
  );

test('photos go to the AI as they are; HEIC and huge ones are refused', async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
  const r = await readFile(jpeg, { name: 'flyer.jpg', mime: 'image/jpeg' });
  assert.equal(r.kind, 'image');
  assert.equal(r.mime, 'image/jpeg');
  assert.equal(Buffer.from(r.data, 'base64').length, jpeg.length);
  // A PNG called .jpg is still a PNG.
  assert.equal((await readFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), { name: 'x.jpg' })).mime, 'image/png');
  await assert.rejects(() => readFile(Buffer.alloc(50, 2), { name: 'IMG_1.HEIC', mime: 'image/heic' }), /HEIC/);
  await assert.rejects(() => readFile(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(6 * 1024 * 1024)]), { name: 'big.jpg' }), /too big/);
});

test('PDFs: text is read here; a scan (no text) goes to the AI as a document', async () => {
  const text = await readFile(makePdf([['Soccer practice Tuesdays 5pm at Central Park', 'Coach: Dana 555-0100']]), { name: 'soccer.pdf' });
  assert.equal(text.kind, 'text');
  assert.match(text.text, /Coach: Dana 555-0100/);
  const scan = await readFile(makePdf([['']]), { name: 'scan.pdf' });
  assert.equal(scan.kind, 'pdf');
});

test('Word documents, spreadsheets, CSV and text files are read as text', async () => {
  const d = await readFile(docx(['Dentist: Dr. Lee', 'Address: 12 Elm St & Main']), { name: 'notes.docx' });
  assert.equal(d.what, 'a Word document');
  assert.equal(d.text, 'Dentist: Dr. Lee\nAddress: 12 Elm St & Main');
  const x = await readFile(xlsx([['Name', 'Phone'], ['Dana', 5550100], ['Sam', 5550101]]), { name: 'team.xlsx' });
  assert.equal(x.text, '--- sheet Team ---\nName | Phone\nDana | 5550100\nSam | 5550101');
  assert.equal((await readFile(Buffer.from('date,what\n2026-11-05,Swim meet'), { name: 'meets.csv' })).text, 'date,what\n2026-11-05,Swim meet');
  assert.equal((await readFile(Buffer.from('Remember: bring snacks'), { name: 'todo.txt' })).text, 'Remember: bring snacks');
});

test('files nobody kept are deleted after 7 days; kept ones stay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'homecircle-files-'));
  try {
    const store = openDb(dir);
    const files = createFiles({ dataDir: dir, store });
    const now = Date.now();
    files.save({ id: 'a'.repeat(24), circleId: 'c1', uploaderId: 'm1', bytes: Buffer.alloc(100), now });
    files.save({ id: 'b'.repeat(24), circleId: 'c1', uploaderId: 'm1', bytes: Buffer.alloc(50), now });
    store.keepFile('b'.repeat(24));
    assert.equal(store.circleFileBytes('c1'), 150);
    assert.equal(store.unkeptFilesBy('m1'), 1);
    files.prune(now + 6 * 86400_000);
    assert.equal(readdirSync(join(dir, 'files')).length, 2);
    files.prune(now + 8 * 86400_000);
    assert.deepEqual(readdirSync(join(dir, 'files')), ['b'.repeat(24)]);
    assert.equal(store.circleFileBytes('c1'), 50);
    files.removeCircle('c1');
    assert.deepEqual(readdirSync(join(dir, 'files')), []);
    assert.throws(() => files.read('../homecircle.db'), /bad file id/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('files it can’t read say what to send instead', async () => {
  await assert.rejects(() => readFile(Buffer.from('xx'), { name: 'old.doc' }), /\.doc files.*PDF, \.docx or \.xlsx/);
  await assert.rejects(() => readFile(Buffer.from([1, 2, 3]), { name: 'thing.bin' }), /a photo, a PDF, a Word document/);
  await assert.rejects(() => readFile(Buffer.from('not a zip'), { name: 'broken.docx' }), /couldn’t be opened/);
});
