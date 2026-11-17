import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { main } from '../src/cli.js';

function capture() {
  const chunks = [];
  const stream = new Writable({ write(chunk, _enc, done) { chunks.push(Buffer.from(chunk)); done(); } });
  Object.defineProperty(stream, 'text', { get: () => Buffer.concat(chunks).toString() });
  return stream;
}

/** Runs init with a recording fetch: no test reaches the network. */
async function run(cwd, args, { env = {}, fetch } = {}) {
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const record = fetch ?? (async (url, init) => { calls.push({ url, ...init }); return new Response(null, { status: 204 }); });
  const code = await main({ argv: ['init', ...args], cwd, env, stdout, stderr, fetch: record });
  return { code, stdout: stdout.text, stderr: stderr.text, calls };
}

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'llms-init-'));
  await mkdir(join(dir, '.git'));
  return dir;
}

const exists = (path) => stat(path).then(() => true, () => false);

test('init --dry-run prints the workflow and writes nothing', async (t) => {
  const dir = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await run(dir, ['--url', 'https://example.com', '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--- .*llms-txt\.yml/);
  assert.match(result.stdout, /\+name: llms\.txt/);
  assert.match(result.stdout, /Would write .*llms-txt\.yml/);
  assert.match(result.stdout, /Dry run: no files written/);
  assert.equal(await exists(join(dir, '.github/workflows/llms-txt.yml')), false);
});

test('init writes the GitHub workflow and uses public/ when present', async (t) => {
  const dir = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'public'));
  const result = await run(dir, ['--github', '--url', 'example.com', '--branch', 'trunk']);
  assert.equal(result.code, 0, result.stderr);
  const file = join(dir, '.github/workflows/llms-txt.yml');
  const text = await readFile(file, 'utf8');
  assert.match(text, /url: https:\/\/example\.com\//);
  assert.match(text, /path: public\/llms\.txt/);
  assert.match(text, /full-path: public\/llms-full\.txt/);
  assert.match(text, /branch: trunk/);
  assert.match(text, /env:\n\s+LLMS_INK_SOURCE: init/, 'Action runs from this workflow are attributable to the install');
  assert.match(result.stdout, /Wrote .*llms-txt\.yml/);
});

test('init is idempotent and refuses a conflicting file without --force', async (t) => {
  const dir = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal((await run(dir, ['--url', 'https://one.example'])).code, 0);
  const same = await run(dir, ['--url', 'https://one.example']);
  assert.equal(same.code, 0);
  assert.match(same.stdout, /already configured/);
  const conflict = await run(dir, ['--url', 'https://two.example']);
  assert.equal(conflict.code, 2);
  assert.match(conflict.stderr, /already exists and differs/);
  const forced = await run(dir, ['--url', 'https://two.example', '--force']);
  assert.equal(forced.code, 0);
  assert.match(await readFile(join(dir, '.github/workflows/llms-txt.yml'), 'utf8'), /https:\/\/two\.example\//);
});

test('init --mcp writes a hosted MCP config without needing a URL', async (t) => {
  const dir = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await run(dir, ['--mcp']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8')), {
    mcpServers: { 'llms-ink': { type: 'http', url: 'https://llms.ink/mcp?source=init' } },
  });
});

test('init counts only the surfaces it wrote, with no site or path', async (t) => {
  const dir = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dry = await run(dir, ['--url', 'https://secret.example', '--mcp', '--github', '--dry-run']);
  assert.deepEqual(dry.calls, [], 'a dry run sends nothing');
  const wrote = await run(dir, ['--url', 'https://secret.example', '--mcp', '--github']);
  assert.equal(wrote.calls.length, 1);
  assert.equal(wrote.calls[0].url, 'https://llms.ink/api/v0/install?surface=github&surface=mcp');
  assert.equal(wrote.calls[0].method, 'POST');
  assert.match(wrote.calls[0].headers['user-agent'], /^llms-ink-cli\/\d+\.\d+\.\d+$/);
  assert.ok(!JSON.stringify(wrote.calls).includes('secret'), 'the site never leaves the machine');
  assert.deepEqual((await run(dir, ['--url', 'https://secret.example', '--mcp', '--github'])).calls, [], 'nothing new written, nothing counted');
});

test('DO_NOT_TRACK skips the count, and a failed count never fails init', async (t) => {
  const dir = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual((await run(dir, ['--mcp'], { env: { DO_NOT_TRACK: '1' } })).calls, []);
  await rm(join(dir, '.mcp.json'));
  const offline = await run(dir, ['--mcp'], { fetch: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(offline.code, 0, offline.stderr);
  assert.ok(await exists(join(dir, '.mcp.json')));
});

test('init requires a Git repository and a valid URL', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'llms-init-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outside = await run(dir, ['--url', 'example.com']);
  assert.equal(outside.code, 2);
  assert.match(outside.stderr, /inside a Git repository/);
  await mkdir(join(dir, '.git'));
  const noUrl = await run(dir, []);
  assert.equal(noUrl.code, 2);
  assert.match(noUrl.stderr, /--url is required/);
  const badUrl = await run(dir, ['--url', 'not a url']);
  assert.equal(badUrl.code, 2);
  assert.match(badUrl.stderr, /use an http\(s\) site link/);
});
