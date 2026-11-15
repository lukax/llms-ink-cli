import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, rename, symlink, link, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { frontMatter } from '../src/context/output.js';

const key = 'lk_' + 'a'.repeat(32);
const digest = text => createHash('sha256').update(text).digest('hex');
const receipt = text => ({ detection: 'no_finding', coverage: 'complete', recommendation: 'continue', reason: 'no_finding',
  modelRevision: '4a43fec65a670e48835d8e8c85c705b4b0d1c907', policyRevision: 'llms-ink-inspect-1', preprocessingRevision: 'utf8-json-stringify-1',
  contentDigest: digest(text), inputTokens: 5, inspectedTokens: 5, windows: 1, enforced: false });
const fields = { package: 'sample', ecosystem: 'npm', version: '1.2.3', docs: 'pinned', sources: ['https://example.com/v1.2.3', 'https://registry.npmjs.org/sample/1.2.3'], generator: 'llms-ink context' };
const body = frontMatter(fields) + '\n\nPRIVATE_SOURCE ordinary documentation.\n';

async function setup(t, entries = { 'sample@1.2.3.md': body, 'README.md': '# Docs\n' }) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ink-context-inspect-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, '.context'));
  for (const [name, text] of Object.entries(entries)) {
    const path = join(cwd, '.context', name);
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text);
  }
  const calls = [], sleeps = [];
  const run = async (args = ['inspect', '--dir', '.context', '-o', 'scan.json'], extra = {}) => {
    let stdout = '', stderr = '';
    const code = await main({ argv: ['context', ...args], cwd, env: { LLMS_INK_INSPECT_KEY: key, LLMS_INK_API: 'https://attacker.invalid' },
      stdout: { write: s => stdout += s }, stderr: { write: s => stderr += s },
      sleep: async ms => { sleeps.push(ms); },
      fetch: async (url, init) => { calls.push({ url, ...init }); return Response.json(receipt(JSON.parse(init.body).content)); }, ...extra });
    return { code, stdout, stderr };
  };
  const record = () => readFile(join(cwd, 'scan.json'), 'utf8').then(JSON.parse);
  return { cwd, calls, sleeps, run, record, verify: extra => run(['verify', '--dir', '.context', '--receipt', 'scan.json'], extra) };
}

test('preview covers nested files and declared sources without credentials, uploads or writes', async t => {
  const f = await setup(t, { 'sample@1.2.3.md': body, 'nested/local.txt': 'local notes' });
  const r = await f.run(['inspect', '--dir', '.context', '--dry-run'], { env: {} });
  assert.equal(r.code, 0, r.stderr); const plan = JSON.parse(r.stdout);
  assert.equal(plan.uploads, 0); assert.equal(f.calls.length, 0);
  assert.deepEqual(plan.files.map(x => x.path), ['nested/local.txt', 'sample@1.2.3.md']);
  assert.deepEqual(plan.files[1].source, { package: 'sample', ecosystem: 'npm', version: '1.2.3', docs: 'pinned', sources: fields.sources });
  assert.equal(plan.files[1].sha256, digest(body)); assert.ok(!r.stdout.includes('PRIVATE_SOURCE'));
  assert.deepEqual(await readdir(f.cwd), ['.context']);
});

test('scan binds exact BOM/JSON bytes, fixes origin, paces requests and writes a private exclusive record', async t => {
  const inputs = { 'b.json': '\uFEFF { "key": "PRIVATE_SOURCE café 🌙" }\r\n', 'a.md': '# Docs\r\n' }, f = await setup(t, inputs);
  const r = await f.run(); assert.equal(r.code, 0, r.stderr);
  const record = await f.record(); assert.equal(record.runState, 'complete'); assert.equal(record.files.length, 2);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.sleeps, [7000]);
  for (const [i, call] of f.calls.entries()) {
    assert.equal(call.url, 'https://llms.ink/api/v0/inspect'); assert.equal(call.redirect, 'error');
    assert.equal(call.headers.authorization, 'Bearer ' + key);
    const source = inputs[record.files[i].path]; assert.deepEqual(JSON.parse(call.body), { format: 'text', content: source });
    assert.equal(record.files[i].sha256, digest(source)); assert.equal(record.files[i].inspection.receipt.contentDigest, digest(source));
  }
  if (process.platform !== 'win32') assert.equal((await stat(join(f.cwd, 'scan.json'))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(record).includes('PRIVATE_SOURCE')); assert.ok(!JSON.stringify(record).includes(key));
  assert.ok(!r.stderr.includes('PRIVATE_SOURCE')); assert.ok(!r.stderr.includes(key));
  assert.equal((await f.run()).code, 2); assert.equal(f.calls.length, 2);
  const verified = await f.verify({ env: {}, fetch: () => assert.fail('Offline verifier must not request') });
  assert.equal(verified.code, 0, verified.stderr); assert.equal(JSON.parse(verified.stdout).status, 'current');
  assert.deepEqual((await readdir(f.cwd)).sort(), ['.context', 'scan.json']);
});

test('all input checks precede uploads: bad paths, flags, unsupported data, empty/oversized files and metadata', async t => {
  for (const args of [['inspect'], ['inspect', '--dir', '.context'], ['inspect', '--dir', '.context', '-o', '.context/scan.json'],
    ['inspect', '--dir', '../.context', '-o', 'scan.json'], ['inspect', '--dir', '.', '-o', 'scan.json'],
    ['inspect', '--dir', '.context', '-o', 'scan.json', '--api', 'https://attacker.invalid'],
    ['inspect', '--dir', '.context', '-o', 'scan.json', '--receipt', 'old.json'],
    ['verify', '--dir', '.context', '--receipt', 'scan.json', '--dry-run']]) {
    const f = await setup(t); assert.notEqual((await f.run(args)).code, 0, args.join(' ')); assert.equal(f.calls.length, 0);
  }
  for (const [name, text] of [['z.env', 'secret'], ['z.md', ''], ['z.md', Buffer.from([255])], ['z.md', 'x'.repeat(131073)],
    ['z.md', '\n'.repeat(66000)], ['z.md', frontMatter({ ...fields, sources: ['file:///secret'] }) + '\nbody'],
    ['z.md', frontMatter({ ...fields, version: '../escape' }) + '\nbody'], ['z.md', frontMatter({ ...fields, sources: ['https://user:password@example.com'] }) + '\nbody']]) {
    const f = await setup(t, { 'a.md': '# valid', [name]: text });
    assert.notEqual((await f.run()).code, 0, name); assert.equal(f.calls.length, 0);
    assert.deepEqual(await readdir(f.cwd), ['.context']);
  }
  const f = await setup(t); assert.equal((await f.run(undefined, { env: {} })).code, 2); assert.equal(f.calls.length, 0);
});

test('symlinks, parent aliases, hard links and special entries are refused before any upload', async t => {
  for (const kind of ['leaf', 'directory', 'parent', 'hardlink', 'output']) {
    const f = await setup(t); await writeFile(join(f.cwd, 'outside.txt'), 'PRIVATE_SOURCE');
    let args;
    if (kind === 'leaf') await symlink(join(f.cwd, 'outside.txt'), join(f.cwd, '.context/z.txt'));
    if (kind === 'directory') await symlink(f.cwd, join(f.cwd, '.context/linked'), 'junction');
    if (kind === 'parent') { await symlink(join(f.cwd, '.context'), join(f.cwd, 'alias'), 'junction'); args = ['inspect', '--dir', 'alias', '-o', 'scan.json']; }
    if (kind === 'hardlink') await link(join(f.cwd, 'outside.txt'), join(f.cwd, '.context/z.txt'));
    if (kind === 'output') await symlink(join(f.cwd, 'outside.txt'), join(f.cwd, 'scan.json'));
    assert.notEqual((await f.run(args)).code, 0, kind); assert.equal(f.calls.length, 0);
    assert.equal(await readFile(join(f.cwd, 'outside.txt'), 'utf8'), 'PRIVATE_SOURCE');
  }
});

test('file count, directory count, depth and empty-pack bounds fail before uploads', async t => {
  for (const kind of ['files', 'directories', 'depth', 'empty']) {
    const f = await setup(t, {});
    if (kind === 'files') for (let i = 0; i < 65; i++) await writeFile(join(f.cwd, '.context', i + '.md'), '# doc');
    if (kind === 'directories') for (let i = 0; i < 128; i++) await mkdir(join(f.cwd, '.context', String(i)));
    if (kind === 'depth') await mkdir(join(f.cwd, '.context', ...Array(33).fill('deep')), { recursive: true });
    assert.notEqual((await f.run()).code, 0, kind); assert.equal(f.calls.length, 0);
  }
});

test('added, removed, renamed, edited and source-metadata-changed files invalidate the record offline', async t => {
  for (const kind of ['added', 'removed', 'renamed', 'edited', 'source']) {
    const f = await setup(t); assert.equal((await f.run()).code, 0);
    const path = join(f.cwd, '.context/sample@1.2.3.md');
    if (kind === 'added') await writeFile(join(f.cwd, '.context/local.txt'), 'notes');
    if (kind === 'removed') await rm(path);
    if (kind === 'renamed') await rename(path, path + '.md');
    if (kind === 'edited') await writeFile(path, body + 'changed');
    if (kind === 'source') await writeFile(path, body.replace('example.com', 'other.example'));
    const r = await f.verify({ fetch: () => assert.fail('offline') });
    assert.equal(r.code, 1, kind); assert.equal(JSON.parse(r.stdout).status, 'stale');
  }
});

test('malformed, missing, duplicate, altered and unsupported manifests never verify', async t => {
  const f = await setup(t); assert.equal((await f.run()).code, 0); const original = await f.record();
  const mutations = [r => r.schema = 'future', r => r.endpoint = 'https://attacker.invalid', r => r.files = [],
    r => r.runState = 'other', r => r.files.push(r.files[0]), r => delete r.files[0].inspection,
    r => r.files[0].sha256 = '0'.repeat(64), r => r.files[0].inspection.receipt.policyRevision = 'future',
    r => r.files[0].inspection.receipt.contentDigest = 'f'.repeat(64), r => r.files[0].inspection.receipt.coverage = 'partial',
    r => r.files[0].inspection.receipt.inspectedTokens = 0, r => r.files[0].inspection.receipt.enforced = true,
    r => r.files[0].inspection.httpStatus = 503, r => r.directory = 'other', r => r.files[0].bytes++,
    r => r.files[0].path = '../outside.md', r => r.files.reverse(), r => r.files[0].source = { package: 'forged' },
    r => r.runState = 'interrupted'];
  for (const mutate of mutations) {
    const copy = structuredClone(original); mutate(copy); await writeFile(join(f.cwd, 'scan.json'), JSON.stringify(copy));
    const result = await f.verify({ fetch: () => assert.fail('offline') }); assert.notEqual(result.code, 0, mutate.toString());
  }
  for (const raw of ['{', 'null', '{}', ' '.repeat(1048577)]) {
    await writeFile(join(f.cwd, 'scan.json'), raw); assert.notEqual((await f.verify()).code, 0);
  }
  await rm(join(f.cwd, 'scan.json')); assert.notEqual((await f.verify()).code, 0);
});

test('flagged and token-limited receipts are retained, later files still inspected, verification withholds', async t => {
  for (const status of [200, 422]) {
    const f = await setup(t); let calls = 0;
    const r = await f.run(undefined, { fetch: async (_, init) => {
      const clean = receipt(JSON.parse(init.body).content); calls++;
      return Response.json(calls > 1 ? clean : { ...clean, recommendation: 'withhold', ...(status === 200
        ? { detection: 'flagged', reason: 'instruction_pattern' }
        : { detection: 'unknown', reason: 'token_limit', coverage: 'none', inputTokens: 9000, inspectedTokens: 0, windows: 0 }) }, { status: calls > 1 ? 200 : status });
    } });
    assert.equal(r.code, 1); assert.equal(calls, 2); assert.equal((await f.verify()).code, 1);
    assert.equal((await f.record()).files[1].inspection.receipt.detection, 'no_finding');
  }
});

test('HTTP failures, invalid receipts, service unavailability and transport failures stop without retries or disclosure', async t => {
  for (const response of [() => Response.json({ detail: 'PRIVATE_SOURCE ' + key }, { status: 429 }),
    () => Response.json({}, { status: 401 }), () => new Response('PRIVATE_SOURCE', { status: 503 }),
    r => Response.json({ ...r, coverage: 'partial' }), () => new Response('x'.repeat(16385)),
    () => { throw Error('PRIVATE_SOURCE ' + key); },
    r => Response.json({ ...r, detection: 'unknown', reason: 'model_unavailable', recommendation: 'withhold', coverage: 'none', inspectedTokens: 0, windows: 0 }, { status: 503 })]) {
    const f = await setup(t); let calls = 0;
    const r = await f.run(undefined, { fetch: async (_, init) => { calls++; return response(receipt(JSON.parse(init.body).content)); } });
    assert.equal(r.code, 1); assert.equal(calls, 1); assert.equal(f.sleeps.length, 0);
    const manifest = await f.record(); assert.equal(manifest.files[1].inspection.state, 'not_attempted');
    for (const text of [r.stdout, r.stderr, JSON.stringify(manifest)]) { assert.ok(!text.includes('PRIVATE_SOURCE')); assert.ok(!text.includes(key)); }
    assert.equal((await f.verify()).code, 1);
  }
});

test('cancellation before upload, during request, pacing and after final response remains explicit', async t => {
  for (const when of ['before', 'request', 'pacing', 'final']) {
    const f = await setup(t), controller = new AbortController(); let calls = 0;
    if (when === 'before') controller.abort();
    const r = await f.run(undefined, { signal: controller.signal,
      sleep: async () => { if (when === 'pacing') { controller.abort(); throw Error('cancelled'); } },
      fetch: async (_, init) => {
        calls++;
        if (when === 'request') return new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(Error('cancelled'))); controller.abort(); });
        if (when === 'final' && calls === 2) controller.abort();
        return Response.json(receipt(JSON.parse(init.body).content));
      } });
    assert.equal(r.code, 1, when); assert.equal(calls, when === 'before' ? 0 : when === 'final' ? 2 : 1);
    assert.equal((await f.record()).runState, 'interrupted'); assert.equal((await f.verify()).code, 1);
    assert.ok(!(await readdir(f.cwd)).some(name => name.endsWith('.tmp')));
  }
});

test('pack mutation during upload retains original scan bytes and fails current-state delivery', async t => {
  for (const kind of ['edit', 'add', 'remove']) {
    const f = await setup(t); let changed = false;
    const r = await f.run(undefined, { fetch: async (_, init) => {
      if (!changed) {
        changed = true;
        if (kind === 'edit') await writeFile(join(f.cwd, '.context/README.md'), '# changed');
        if (kind === 'add') await writeFile(join(f.cwd, '.context/z.txt'), 'new');
        if (kind === 'remove') await rm(join(f.cwd, '.context/README.md'));
      }
      return Response.json(receipt(JSON.parse(init.body).content));
    } });
    assert.equal(r.code, 1); assert.equal(JSON.parse(r.stdout).status, 'stale');
    assert.equal((await f.record()).files[0].sha256, digest('# Docs\n'));
    assert.equal((await f.verify()).code, 1);
  }
});

test('a concurrent output creator is preserved and temporary receipt is cleaned', async t => {
  const f = await setup(t);
  const r = await f.run(undefined, { fetch: async (_, init) => { await writeFile(join(f.cwd, 'scan.json'), 'other writer'); return Response.json(receipt(JSON.parse(init.body).content)); } });
  assert.equal(r.code, 1); assert.equal(await readFile(join(f.cwd, 'scan.json'), 'utf8'), 'other writer');
  assert.ok(!(await readdir(f.cwd)).some(name => name.endsWith('.tmp')));
});

test('inspect and verify help require no key or files', async t => {
  const f = await setup(t);
  for (const mode of ['inspect', 'verify']) {
    const r = await f.run([mode, '--help'], { env: {} }); assert.equal(r.code, 0); assert.match(r.stdout, /Unsigned receipts can be forged/);
  }
  assert.equal(f.calls.length, 0);
});

test('real context generation, preview, scan and offline verification compose without implicit uploads', async t => {
  const f = await setup(t, {}); await writeFile(join(f.cwd, 'package.json'), JSON.stringify({ dependencies: { sample: '1.2.3' } }));
  let uploads = 0;
  const fetch = async (url, init = {}) => {
    if (url === 'https://llms.ink/api/v0/inspect') { uploads++; return Response.json(receipt(JSON.parse(init.body).content)); }
    if (String(url).startsWith('https://llms.ink/api/v0/llms?')) return Response.json({ text: '# Sample\n\n## Usage\n\nCall sample().', source: 'native' });
    if (url === 'https://registry.npmjs.org/sample/1.2.3') return Response.json({ name: 'sample', version: '1.2.3', homepage: 'https://example.com/1.2.3' });
    return new Response(null, { status: 404 });
  };
  const generated = await f.run(['--max', '1', '--tokens', '1500', '--agents-md', 'none'], { fetch, env: {} });
  assert.equal(generated.code, 0, generated.stderr); assert.equal(uploads, 0);
  assert.deepEqual((await readdir(join(f.cwd, '.context'))).sort(), ['README.md', 'sample@1.2.3.md']);
  const preview = await f.run(['inspect', '--dir', '.context', '--dry-run'], { fetch, env: {} });
  assert.equal(preview.code, 0, preview.stderr); assert.equal(uploads, 0);
  assert.equal((await f.run(undefined, { fetch })).code, 0); assert.equal(uploads, 2);
  assert.equal((await f.verify({ fetch, env: {} })).code, 0); assert.equal(uploads, 2);
  assert.equal((await f.record()).files[1].source.version, '1.2.3');
});

test('real SIGTERM aborts the binary request, preserves interruption and removes temporary output', { skip: process.platform === 'win32' }, async t => {
  const f = await setup(t);
  const preload = join(f.cwd, 'preload.mjs');
  await writeFile(preload, `import {writeFileSync} from 'node:fs';\nglobalThis.fetch=async (_url, init)=>new Promise((_resolve,reject)=>{writeFileSync('started','yes');init.signal.addEventListener('abort',()=>reject(Error('cancelled')));});\n`);
  const child = spawn(process.execPath, ['--import', preload, fileURLToPath(new URL('../bin/llms-ink.js', import.meta.url)), 'context', 'inspect', '--dir', '.context', '-o', 'scan.json'],
    { cwd: f.cwd, env: { ...process.env, LLMS_INK_INSPECT_KEY: key }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  let started = false;
  for (let i = 0; i < 100; i++) {
    if (await stat(join(f.cwd, 'started')).then(() => true, () => false)) { started = true; break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(started, 'child reached the request'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  let stopped;
  try { stopped = await closed; } finally { clearTimeout(timer); }
  assert.deepEqual(stopped, { code: 1, signal: null });
  const record = await f.record(); assert.equal(record.runState, 'interrupted');
  assert.equal(record.files[0].inspection.reason, 'cancelled'); assert.equal(record.files[1].inspection.state, 'not_attempted');
  assert.ok(!(await readdir(f.cwd)).some(name => name.endsWith('.tmp')));
});
