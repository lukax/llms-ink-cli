import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { VERSION, fileNameFor, looksLikePath, main, parseTime } from '../src/cli.js';
import { FULL, JPEG, KEY, LLMS, MP4, parseLlms, startMock } from './mock.js';

const LOCAL = '# Example\n\n> Docs for Example.\n\nRead these first.\n\n## Docs\n\n- [Guide](/guide.md): How to start\n- [Old page](/gone.md)\n\n## Optional\n\n- [Blog](https://example.com/blog/)\n';
const BASE = 'https://example.com/llms.txt';

const BIN = fileURLToPath(new URL('../bin/llms-ink.js', import.meta.url));
const run = promisify(execFile);
const VIDEO = 'https://youtu.be/jNQXAC9IVRw';

function capture(isTTY = false) {
  const chunks = [];
  const stream = new Writable({ write(chunk, _enc, done) { chunks.push(Buffer.from(chunk)); done(); } });
  stream.isTTY = isTTY;
  Object.defineProperty(stream, 'text', { get: () => Buffer.concat(chunks).toString() });
  Object.defineProperty(stream, 'bytes', { get: () => Buffer.concat(chunks) });
  return stream;
}

let mock;
let dir;
test.before(async () => { mock = await startMock(); });
test.after(async () => { await mock.close(); });
test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'llms-ink-')); mock.requests.length = 0; });
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function cli(argv, { env = {}, stdin } = {}) {
  const stdout = capture();
  const stderr = capture();
  const code = await main({ argv, env: { LLMS_INK_API: mock.api, ...env }, cwd: dir, stdout, stderr, stdin: stdin === undefined ? undefined : Readable.from([Buffer.from(stdin)]) });
  return { code, stdout: stdout.text, bytes: stdout.bytes, stderr: stderr.text };
}

test('times, file names and versions', async () => {
  assert.equal(parseTime('1:30'), '1:30');
  assert.equal(parseTime('90.5'), '90.5');
  for (const bad of ['1:75', 'soon', '-1']) assert.throws(() => parseTime(bad), /--time/);
  assert.equal(fileNameFor('https://developers.cloudflare.com/kv/', false), 'developers.cloudflare.com-kv-llms.txt');
  assert.equal(fileNameFor('github.com/honojs/hono', true), 'github.com-honojs-hono-llms-full.txt');
  assert.equal(fileNameFor('www.example.com', false), 'example.com-llms.txt');
  for (const path of ['./llms.txt', '../x', '/tmp/llms.txt', '~/llms.txt', 'public/llms.txt', 'docs\\llms.md', 'C:\\site\\llms.txt']) assert.ok(looksLikePath(path), path);
  for (const link of ['llmstxt.org', 'llms.txt', 'example.com/llms.txt', 'https://example.com/llms.txt', 'localhost:8787/llms.txt', 'github.com/honojs/hono', 'public/llms']) assert.ok(!looksLikePath(link), link);
  const version = await cli(['-v']);
  assert.equal(version.stdout, `${VERSION}\n`);
  assert.equal(VERSION, JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  const help = await cli(['--help']);
  assert.match(help.stdout, /llms-ink frame <video>/);
  assert.match(help.stdout, /llms-ink parse <file\|-\|link>/);
  assert.equal((await cli([])).code, 2);
});

test('wrong usage exits 2 with a reason and makes no request', async () => {
  for (const [argv, why] of [
    [['--wat'], /Unknown option/],
    [['frame'], /Give a link: llms-ink frame <link>/],
    [['a.com', 'b.com'], /One link at a time/],
    [['frame', VIDEO, '--full'], /are for llms\.txt/],
    [['media', VIDEO, '--generated'], /are for llms\.txt/],
    [['media', VIDEO, '--json'], /--json is for llms\.txt, check, parse, report and generate/],
    [['generate'], /Give a kind and a link: llms-ink generate <agents-md\|jsonld\|alt-text\|answers> <link>/],
    [['generate', 'agents-md'], /Give a kind and a link/],
    [['generate', 'poem', 'llmstxt.org'], /Unknown kind “poem”: use agents-md, jsonld, alt-text, answers/],
    [['generate', 'jsonld', 'a.com', 'b.com'], /One link at a time/],
    [['generate', 'jsonld', 'a.com', '--full'], /are for llms\.txt/],
    [['report'], /Give a link: llms-ink report <link>/],
    [['report', 'llmstxt.org', '-o', 'x.txt'], /report prints its report/],
    [['report', 'llmstxt.org', '--base', BASE], /--base is for check and parse/],
    [['report', 'llmstxt.org', '--links'], /--links is for check/],
    [['report', 'llmstxt.org', '--full'], /are for llms\.txt/],
    [['check'], /Give a site, a file or -: llms-ink check <site\|file\|->/],
    [['parse'], /Give a file, - or a link: llms-ink parse <file\|-\|link>/],
    [['parse', 'llmstxt.org', '-o', 'x.txt'], /parse prints its report/],
    [['check', 'llmstxt.org', '--base', BASE], /--base and --links are for a file or -/],
    [['check', 'llmstxt.org', '--links'], /--base and --links are for a file or -/],
    [['parse', 'llmstxt.org', '--base', BASE], /--base and --links are for a file or -/],
    [['parse', '-', '--links'], /--links is for check/],
    [['frame', VIDEO, '--base', BASE], /--base is for check and parse/],
    [['check', 'public/llms.txt'], /No such file: public\/llms\.txt/],
    [['check', './nope.md', '--links'], /No such file: \.\/nope\.md/],
    [['parse', '/no/such/llms.txt'], /No such file: \/no\/such\/llms\.txt/],
    [['check', 'llmstxt.org', '--full'], /are for llms\.txt/],
    [['check', 'llmstxt.org', '-o', 'x.txt'], /redirect it/],
    [['a.com', '-t', '5'], /for frame/],
    [['a.com', '--audio'], /for media/],
    [['frame', VIDEO, '-t', 'soon'], /--time/],
    [['frame', VIDEO, '-w', '5000'], /--width/],
  ]) {
    const result = await cli(argv);
    assert.equal(result.code, 2, argv.join(' '));
    assert.match(result.stderr, why, argv.join(' '));
  }
  assert.equal(mock.requests.length, 0);
});

test('a link prints its llms.txt on stdout, and a summary on stderr', async () => {
  const result = await cli(['llmstxt.org']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, LLMS);
  assert.deepEqual(mock.requests[0], { path: '/api/v0/llms', query: { url: 'llmstxt.org', mode: 'llms' } });
  assert.match(result.stderr, /site · native · 52 tokens · 1 links · cached/);
});

test('--full and --fresh ask for llms-full.txt and a rebuild', async () => {
  const result = await cli(['llmstxt.org', '--full', '--fresh']);
  assert.equal(result.stdout, FULL);
  assert.deepEqual(mock.requests[0].query, { url: 'llmstxt.org', mode: 'full', fresh: '1' });
  assert.match(result.stderr, /1,234 tokens · 3 pages/);
  assert.doesNotMatch(result.stderr, /cached/);
});

test('--json gives the whole answer; --quiet keeps stderr empty', async () => {
  const result = await cli(['llmstxt.org', '--json', '--quiet']);
  const data = JSON.parse(result.stdout);
  assert.equal(data.kind, 'site');
  assert.equal(data.text, LLMS);
  assert.equal(result.stderr, '');
});

test('-o saves to a file, or into a folder under a name from the link, and prints the path', async () => {
  const file = await cli(['llmstxt.org', '-o', 'out.txt']);
  assert.equal(await readFile(join(dir, 'out.txt'), 'utf8'), LLMS);
  assert.equal(file.stdout, `${join(dir, 'out.txt')}\n`);
  await cli(['https://developers.cloudflare.com/kv/', '--full', '-o', 'docs/', '--quiet']);
  assert.equal(await readFile(join(dir, 'docs', 'developers.cloudflare.com-kv-llms-full.txt'), 'utf8'), FULL);
});

test('the API’s message is shown when it refuses (exit 1)', async () => {
  const privatePage = await cli(['example.com/private']);
  assert.equal(privatePage.code, 1);
  assert.equal(privatePage.stderr.trim().split('\n').at(-1), 'llms-ink: That page needs a login; llms.ink only reads public pages.');
  const limit = await cli(['frame', 'youtu.be/limit']);
  assert.match(limit.stderr, /Daily limit reached/);
});

test('frame saves the JPEG under the server’s name, or where -o says, or to stdout', async () => {
  const named = await cli(['frame', VIDEO, '-t', '1:30', '-w', '640']);
  assert.equal(named.code, 0, named.stderr);
  assert.deepEqual(mock.requests[0].query, { url: VIDEO, t: '1:30', w: '640' });
  assert.ok((await readFile(join(dir, 'frame-90s.jpg'))).equals(JPEG));
  await cli(['frame', VIDEO, '-o', 'zoo.jpg', '--quiet']);
  assert.ok((await readFile(join(dir, 'zoo.jpg'))).equals(JPEG));
  const piped = await cli(['frame', VIDEO, '-o', '-']);
  assert.ok(piped.bytes.equals(JPEG));
});

test('media downloads the video or its audio, with the name the server gives, and no partial file', async () => {
  const video = await cli(['media', VIDEO, '--quiet']);
  assert.equal(video.code, 0, video.stderr);
  assert.ok((await readFile(join(dir, 'Me at the zoo.mp4'))).equals(MP4));
  await cli(['media', VIDEO, '--audio', '-o', 'audio/', '--quiet']);
  assert.deepEqual(mock.requests.at(-1).query, { url: VIDEO, format: 'm4a' });
  assert.ok((await readFile(join(dir, 'audio', 'Me at the zoo.m4a'))).equals(MP4));
  assert.deepEqual((await readdir(dir)).sort(), ['Me at the zoo.mp4', 'audio']);
});

test('the API address comes from --api or LLMS_INK_API; an unreachable one is explained', async () => {
  const flag = await cli(['llmstxt.org', '--api', `${mock.api}/`], { env: { LLMS_INK_API: 'http://127.0.0.1:9' } });
  assert.equal(flag.code, 0);
  const down = await cli(['llmstxt.org'], { env: { LLMS_INK_API: 'http://127.0.0.1:9' } });
  assert.equal(down.code, 1);
  assert.match(down.stderr, /Couldn’t reach http:\/\/127\.0\.0\.1:9/);
});

test('an API key from --key or LLMS_INK_KEY goes in Authorization; none is sent without one; a bad one is explained', async () => {
  assert.equal((await cli(['llmstxt.org', '--key', KEY], { env: { LLMS_INK_KEY: 'lk_ignored' } })).code, 0);
  assert.equal((await cli(['frame', VIDEO, '-o', 'f.jpg'], { env: { LLMS_INK_KEY: KEY } })).code, 0);
  assert.equal((await cli(['llmstxt.org'], { env: { LLMS_INK_KEY: ' ' } })).code, 0);
  assert.deepEqual(mock.requests.map((r) => r.authorization), [`Bearer ${KEY}`, `Bearer ${KEY}`, undefined]);
  const bad = await cli(['llmstxt.org', '--key', 'lk_revoked']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /isn’t valid or was revoked/);
});

test('--generated asks for a generated file, never the site’s own (native=0)', async () => {
  const result = await cli(['llmstxt.org', '--generated', '--quiet']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(mock.requests[0].query, { url: 'llmstxt.org', mode: 'llms', native: '0' });
});

test('check prints the report and exits 0 when clean, even with warnings', async () => {
  const clean = await cli(['check', 'llmstxt.org']);
  assert.equal(clean.code, 0, clean.stderr);
  assert.deepEqual(mock.requests[0], { path: '/api/v0/check', query: { url: 'llmstxt.org' } });
  assert.equal(clean.stdout, 'https://llmstxt.org/llms.txt: 0 errors, 0 warnings · 1 section · 3 links (3 checked, 0 broken) · ~52 tokens · llms-full.txt not found\n');
  const warned = await cli(['check', 'llmstxt.org/warn']);
  assert.equal(warned.code, 0);
  assert.match(warned.stdout, /0 errors, 1 warning ·[^]*\n\n- warning: No summary blockquote under the title\.\n$/);
});

test('check exits 1 on errors or any broken link, listing them; --json prints the raw result', async () => {
  const broken = await cli(['check', 'llmstxt.org/broken']);
  assert.equal(broken.code, 1);
  assert.match(broken.stdout, /1 error, 0 warnings/);
  assert.match(broken.stdout, /- error \(line 7\): https:\/\/llmstxt\.org\/gone\.md answers HTTP 404\./);
  assert.match(broken.stdout, /Broken links:\n- https:\/\/llmstxt\.org\/gone\.md \(HTTP 404\)\n$/);
  const slow = await cli(['check', 'llmstxt.org/slow']);
  assert.equal(slow.code, 1, 'a link that didn’t answer is broken too');
  assert.match(slow.stdout, /- https:\/\/llmstxt\.org\/slow\.md \(no answer\)/);
  const json = await cli(['check', 'llmstxt.org/broken', '--json', '--quiet']);
  assert.equal(json.code, 1);
  assert.deepEqual(JSON.parse(json.stdout).links.broken, [{ url: 'https://llmstxt.org/gone.md', status: 404 }]);
  assert.equal(json.stderr, '');
  const refused = await cli(['check', 'example.com/private']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /needs a login/);
});

test('check sends a file’s text (POST); the report is headed by the file name, llms-full.txt not checked', async () => {
  await writeFile(join(dir, 'llms.txt'), LOCAL);
  const result = await cli(['check', 'llms.txt']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(mock.requests[0], { path: '/api/v0/check', query: {}, method: 'POST', type: 'text/plain; charset=utf-8', body: LOCAL });
  assert.equal(result.stdout, `llms.txt: 0 errors, 0 warnings · 2 sections · 3 links (0 checked, 0 broken) · ~${Math.ceil(LOCAL.length / 4)} tokens · llms-full.txt not checked\n`);
  assert.match(result.stderr, /Checking llms\.txt/);
});

test('check a file with --base and --links: the report is headed by the base URL and exits 1 on broken links', async () => {
  await writeFile(join(dir, 'llms.txt'), LOCAL);
  const result = await cli(['check', 'llms.txt', '--base', BASE, '--links', '--key', KEY]);
  assert.equal(result.code, 1);
  assert.deepEqual(mock.requests[0].query, { base: BASE, links: '1' });
  assert.equal(mock.requests[0].authorization, `Bearer ${KEY}`);
  assert.match(result.stdout, /^https:\/\/example\.com\/llms\.txt: 1 error, 0 warnings · 2 sections · 3 links \(3 checked, 1 broken\)[^\n]* · llms-full\.txt not found\n/);
  assert.match(result.stdout, /- error \(line 10\): https:\/\/example\.com\/gone\.md answers HTTP 404\./);
  assert.match(result.stdout, /Broken links:\n- https:\/\/example\.com\/gone\.md \(HTTP 404\)\n$/);
  const json = await cli(['check', 'llms.txt', '--base', BASE, '--json', '--quiet']);
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.stdout).parsed, parseLlms(LOCAL, BASE));
});

test('check - reads stdin; a file without a title exits 1; the API’s refusal is shown', async () => {
  const piped = await cli(['check', '-'], { stdin: LOCAL });
  assert.equal(piped.code, 0, piped.stderr);
  assert.equal(mock.requests[0].body, LOCAL);
  assert.match(piped.stdout, /^stdin: 0 errors/);
  const untitled = await cli(['check', '-'], { stdin: 'just text\n' });
  assert.equal(untitled.code, 1);
  assert.match(untitled.stdout, /^stdin: 1 error[^]*\n\n- error \(line 1\): Start with a # title\.\n$/);
  const empty = await cli(['check', '-'], { stdin: '' });
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /llms-ink: Send the llms\.txt text in the body\./);
  const badBase = await cli(['check', '-', '--base', 'nope'], { stdin: LOCAL });
  assert.equal(badBase.code, 1);
  assert.match(badBase.stderr, /base: use a public http\(s\) URL/);
});

test('parse prints the title, summary, and each section with its links; --json prints parsed only', async () => {
  await writeFile(join(dir, 'llms.txt'), LOCAL);
  const result = await cli(['parse', 'llms.txt', '--base', BASE]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(mock.requests[0].query, { base: BASE });
  assert.equal(result.stdout, [
    'Example', 'Docs for Example.', '',
    'Docs · 2 links', '- Guide  https://example.com/guide.md', '- Old page  https://example.com/gone.md', '',
    'Optional · 1 link · optional', '- Blog  https://example.com/blog/', '',
  ].join('\n'));
  const relative = await cli(['parse', '-', '--quiet'], { stdin: LOCAL });
  assert.match(relative.stdout, /- Guide {2}\/guide\.md\n/);
  assert.equal(relative.stderr, '');
  const json = await cli(['parse', 'llms.txt', '--json', '--quiet']);
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.stdout), parseLlms(LOCAL, null));
});

test('parse a link reads its published llms.txt (GET); nothing parseable exits 1', async () => {
  const site = await cli(['parse', 'llmstxt.org']);
  assert.equal(site.code, 0, site.stderr);
  assert.deepEqual(mock.requests[0], { path: '/api/v0/check', query: { url: 'llmstxt.org' } });
  await cli(['check', 'example.com/llms.txt', '--quiet']);
  assert.deepEqual(mock.requests[1], { path: '/api/v0/check', query: { url: 'example.com/llms.txt' } }, 'a host with a path is a link');
  assert.equal(site.stdout, 'llms.txt\nA proposal for LLM-friendly content.\n\nDocs · 1 link\n- Proposal  https://llmstxt.org/index.md\n');
  const missing = await cli(['parse', 'llmstxt.org/missing']);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /llms-ink: No llms\.txt found for https:\/\/llmstxt\.org\.\n$/);
  const missingJson = await cli(['parse', 'llmstxt.org/missing', '--json', '--quiet']);
  assert.equal(missingJson.code, 1);
  assert.equal(missingJson.stdout, 'null\n');
  const untitled = await cli(['parse', '-'], { stdin: '## Docs\n\n- [A](https://a.example/)\n' });
  assert.equal(untitled.code, 1);
  assert.match(untitled.stderr, /llms-ink: stdin has no title/);
  const missingCheck = await cli(['check', 'llmstxt.org/missing']);
  assert.equal(missingCheck.code, 1);
  assert.match(missingCheck.stdout, /^No llms\.txt found for https:\/\/llmstxt\.org\.\n/);
});

test('report prints the summary, the share link and each section with problems first and their fixes; exits 0 without a fail', async () => {
  const r = await cli(['report', 'llmstxt.org/guide']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(mock.requests, [{ path: '/api/v0/report', query: { url: 'llmstxt.org/guide' } }]);
  assert.equal(r.stdout, [
    'https://llmstxt.org/guide: 0 fail, 1 warn, 1 pass, 1 info',
    `Share: ${mock.api}/report/?url=https%3A%2F%2Fllmstxt.org%2Fguide`,
    '',
    'Access',
    '  · info  Training crawlers: All 6 training crawlers may use this page.',
    '          fix: Your call.',
    '  ✓ pass  AI search crawlers: robots.txt lets every AI search crawler read this page.',
    '',
    'Rendering',
    '  ! warn  Text without JavaScript: Only 90 words in the HTML.',
    '          fix: Render on the server.',
    '',
  ].join('\n'));
});

test('report exits 1 on any fail, pointing to the patch; --json prints the raw report; refusals are shown', async () => {
  const blocked = await cli(['report', 'example.com/blocked', '--quiet']);
  assert.equal(blocked.code, 1);
  assert.equal(blocked.stderr, '');
  assert.match(blocked.stdout, /^https:\/\/example\.com\/blocked: 1 fail, 1 warn, 0 pass, 1 info\n/);
  assert.match(blocked.stdout, /\n {2}✕ fail {2}AI search crawlers: robots\.txt keeps OAI-SearchBot from this page\.\n {10}fix: Allow OAI-SearchBot in robots\.txt\. \(--json has the new \/robots\.txt\)\n/);
  const json = await cli(['report', 'example.com/blocked', '--json', '--quiet']);
  assert.equal(json.code, 1);
  const report = JSON.parse(json.stdout);
  assert.equal(report.sections[0].checks[0].fix.patch.content, 'User-agent: OAI-SearchBot\nAllow: /\n');
  const limited = await cli(['report', 'example.com/limit']);
  assert.equal(limited.code, 1);
  assert.match(limited.stderr, /llms-ink: Daily limit reached/);
});

test('the installed command runs as a program: stdout, stdin, exit codes', async () => {
  const env = { ...process.env, LLMS_INK_API: mock.api, LLMS_INK_KEY: '' };
  const ok = await run(process.execPath, [BIN, 'llmstxt.org', '--quiet'], { env });
  assert.equal(ok.stdout, LLMS);
  const piped = run(process.execPath, [BIN, 'parse', '-', '--quiet'], { env });
  piped.child.stdin.end(LOCAL);
  assert.match((await piped).stdout, /^Example\nDocs for Example\.\n/);
  await assert.rejects(run(process.execPath, [BIN, 'example.com/private'], { env }), (err) => err.code === 1 && /needs a login/.test(err.stderr));
  await assert.rejects(run(process.execPath, [BIN, '--nope'], { env }), (err) => err.code === 2);
});

test('generate prints usable drafts per kind, notes on stderr; -o saves; --json and --fresh pass through', async () => {
  const agents = await cli(['generate', 'agents-md', 'github.com/acme/widget']);
  assert.equal(agents.code, 0);
  assert.equal(agents.stdout, '# AGENTS.md\n\n## Commands\n\n- `npm run build`: `tsc` <!-- package.json:4 -->\n');
  assert.match(agents.stderr, /1 draft · written by stub\/model · cached\n {2}1 model line rejected: not supported by the sources\./);
  assert.deepEqual(mock.requests.at(-1), { path: '/api/v0/generate', query: { url: 'github.com/acme/widget', kind: 'agents-md' } });

  const jsonld = await cli(['generate', 'jsonld', 'widget.dev', '--fresh', '--quiet']);
  assert.deepEqual(JSON.parse(jsonld.stdout).map((o) => o['@type']), ['WebSite', 'Organization'], 'one JSON-LD array, ready for a script tag');
  assert.equal(jsonld.stderr, '');
  assert.equal(mock.requests.at(-1).query.fresh, '1');
  assert.equal((await cli(['generate', 'alt-text', 'widget.dev/gallery', '--quiet'])).stdout, '/chart.png\n  alt="Bar chart of &quot;sales&quot; by quarter"\n');
  assert.equal((await cli(['generate', 'answers', 'widget.dev/guide', '--quiet'])).stdout, '<!-- was: ## Installation -->\n## How do you install Widget?\n\nRun `npm i widget`.\n');

  const saved = await cli(['generate', 'agents-md', 'github.com/acme/widget', '-o', join(dir, 'AGENTS.md')]);
  assert.match(await readFile(join(dir, 'AGENTS.md'), 'utf8'), /^# AGENTS\.md/);
  assert.match(saved.stderr, /Saved AGENTS\.md · 1 draft/);
  const json = await cli(['generate', 'answers', 'widget.dev/guide', '--json']);
  assert.equal(JSON.parse(json.stdout).kind, 'answers');
  const empty = await cli(['generate', 'answers', 'widget.dev/empty']);
  assert.equal(empty.code, 0);
  assert.equal(empty.stdout, '');
  assert.match(empty.stderr, /0 drafts · written by stub\/model · cached\n {2}No H2 sections with text on this page\./);
});
