// The server's startup message, as someone running it for the first time sees it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function startAndRead(env, dataDir) {
  const dir = dataDir || mkdtempSync(join(tmpdir(), 'homecircle-start-'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { PATH: process.env.PATH, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, ...env },
    });
    let out = '';
    const timer = setTimeout(() => finish(new Error(`no startup message:\n${out}`)), 8000);
    const finish = (err) => {
      clearTimeout(timer);
      child.kill();
      if (!dataDir) rmSync(dir, { recursive: true, force: true });
      if (err) reject(err);
      else resolve(out);
    };
    child.stdout.on('data', (d) => {
      out += d;
      if (/──────────[\s\S]*──────────/.test(out.split('no circle yet')[1] ?? '')) finish();
    });
    child.stderr.on('data', (d) => (out += d));
  });
}

test('without SETUP_TOKEN, the log shows a generated setup code that survives restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'homecircle-start-'));
  try {
    const code = (out) => out.match(/this setup code:\s+([A-Za-z0-9_-]{12,})/)?.[1];
    const first = code(await startAndRead({}, dir));
    assert.ok(first);
    assert.equal(code(await startAndRead({}, dir)), first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with SETUP_TOKEN, the log never prints it', async () => {
  const out = await startAndRead({ SETUP_TOKEN: 'my-own-setup-code-123' });
  assert.match(out, /the setup code you chose/);
  assert.doesNotMatch(out, /my-own-setup-code-123/);
});
