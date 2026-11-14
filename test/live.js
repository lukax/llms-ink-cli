// Against the real llms.ink (npm run test:live): may use a couple of today's new links. Not part of npm test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/llms-ink.js', import.meta.url));
const VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const run = (args) => promisify(execFile)(process.execPath, [BIN, ...args], { timeout: 5 * 60_000, maxBuffer: 64 * 1024 * 1024 });
const API = (process.env.LLMS_INK_API || 'https://llms.ink').replace(/\/+$/, '');
const SAMPLE = '# Example\n\n> A sample llms.txt.\n\n## Docs\n\n- [Guide](/guide.md): How to start\n\n## Optional\n\n- [Blog](https://example.com/blog/)\n';

/** False (and the test skipped) while POST /api/v0/check isn't deployed: it answers 404 or 405. */
async function canPostCheck(t) {
  const res = await fetch(`${API}/api/v0/check`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: SAMPLE });
  if (res.status !== 404 && res.status !== 405) return true;
  t.skip(`POST /api/v0/check answers ${res.status}: not deployed yet`);
  return false;
}

async function head(path, n) {
  const file = await open(path);
  const buf = Buffer.alloc(n);
  await file.read(buf, 0, n, 0);
  await file.close();
  return buf;
}

test('a real site comes back as llms.txt', async () => {
  const { stdout } = await run(['llmstxt.org', '--quiet']);
  assert.match(stdout, /^# /);
  assert.match(stdout, /\]\(https?:\/\//);
});

test('--json describes what was built', async () => {
  const { stdout } = await run(['llmstxt.org', '--json', '--quiet']);
  const data = JSON.parse(stdout);
  assert.equal(data.mode, 'llms');
  assert.ok(data.tokens > 0);
});

test('a real video frame is a JPEG, and the video downloads as MP4', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llms-ink-live-'));
  try {
    const frame = (await run(['frame', VIDEO, '-t', '0:05', '-w', '320', '-o', `${dir}/`])).stdout.trim();
    assert.deepEqual([...(await head(frame, 3))], [0xff, 0xd8, 0xff], 'JPEG');
    const video = (await run(['media', VIDEO, '-o', `${dir}/`])).stdout.trim();
    assert.equal((await head(video, 8)).subarray(4, 8).toString(), 'ftyp', 'MP4');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check and parse send a local file or stdin (POST /api/v0/check)', async (t) => {
  if (!(await canPostCheck(t))) return;
  const dir = await mkdtemp(join(tmpdir(), 'llms-ink-live-'));
  try {
    const file = join(dir, 'llms.txt');
    await writeFile(file, SAMPLE);
    const check = await run(['check', file, '--base', 'https://example.com/llms.txt', '--quiet']);
    assert.match(check.stdout, /^https:\/\/example\.com\/llms\.txt: 0 errors, [^\n]* · llms-full\.txt not checked\n/);
    const parsed = JSON.parse((await run(['parse', file, '--base', 'https://example.com/llms.txt', '--json', '--quiet'])).stdout);
    assert.equal(parsed.title, 'Example');
    assert.equal(parsed.summary, 'A sample llms.txt.');
    assert.deepEqual(parsed.sections.map((s) => [s.name, s.optional]), [['Docs', false], ['Optional', true]]);
    assert.deepEqual(parsed.sections[0].links[0], { title: 'Guide', url: 'https://example.com/guide.md', notes: 'How to start', line: 7 });
    const piped = run(['parse', '-', '--quiet']);
    piped.child.stdin.end(SAMPLE);
    assert.match((await piped).stdout, /^Example\nA sample llms\.txt\.\n\nDocs · 1 link\n- Guide {2}/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parse reads a published llms.txt (GET /api/v0/check)', async (t) => {
  if (!(await canPostCheck(t))) return;
  const parsed = JSON.parse((await run(['parse', 'llmstxt.org', '--json', '--quiet'])).stdout);
  assert.ok(parsed.title);
  assert.ok(parsed.sections.length > 0);
});

test('context writes pinned docs for a Go module from the real proxy and pkg.go.dev', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llms-ink-context-live-'));
  try {
    await writeFile(join(dir, 'go.mod'), 'module example.com/app\n\ngo 1.22\n\nrequire github.com/spf13/cobra v1.8.1\n');
    await writeFile(join(dir, 'main.go'), 'package main\n\nimport "github.com/spf13/cobra"\n\nfunc main() { _ = (&cobra.Command{}).Execute() }\n');
    const { stdout } = await run(['context', '--manifest', join(dir, 'go.mod'), '--out', join(dir, '.context'), '--agents-md', join(dir, 'AGENTS.md'), '--max', '1', '--quiet']);
    assert.match(stdout, /github\.com__spf13__cobra@v1\.8\.1\.md {2}\(pinned/);
    const file = await readFile(join(dir, '.context', 'github.com__spf13__cobra@v1.8.1.md'), 'utf8');
    assert.match(file, /sources:\n {2}- https:\/\/pkg\.go\.dev\/github\.com\/spf13\/cobra@v1\.8\.1\n/);
    assert.match(file, /Command/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
