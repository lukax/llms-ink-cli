// llms-ink CLI: turn any link into llms.txt / llms-full.txt, check or parse an llms.txt, grab video frames and downloads, through the llms.ink API.
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';

export const VERSION = '0.7.1';
const DEFAULT_API = 'https://llms.ink';

const HELP = `llms-ink ${VERSION} — any link into llms.txt, for your AI

Usage
  llms-ink <link> [options]              print llms.txt for a site, docs section, page, repo, PDF or video
  llms-ink <link> --full                 print llms-full.txt (the index plus the pages' content)
  llms-ink frame <video> [-t 1:30]       save a frame of a video as JPEG
  llms-ink media <video> [--audio]       download the video (MP4) or its audio (M4A)
  llms-ink check <site|file|->           check an llms.txt (a site's, a local file or stdin): format and links
  llms-ink parse <file|-|link>           print an llms.txt's title, summary, sections and links
  llms-ink report <link>                 what AI crawlers and agents see on a page, with fixes; exits 1 on any fail
  llms-ink generate <kind> <link>        draft AGENTS.md (agents-md), JSON-LD (jsonld), alt text (alt-text) or answer-first headings (answers)
  llms-ink notion <link> --parent <page> save llms.txt (llms-full.txt with --full) as a Notion page; prints its URL
  llms-ink inspect --file <path>        hosted text inspection; enabled key required (inspect --help)
  llms-ink context [--manifest <f>]...   write version-pinned docs for your dependencies to .context/ (context --help)

Options
      --full          llms-full.txt instead of llms.txt
      --fresh         rebuild instead of using the 24 h cache (counts as a new link); also for generate
      --generated     always generate; never the site's own llms.txt (for a site whose llms.txt comes from llms.ink)
  -o, --output <p>    file or folder to save to; - for stdout
  -t, --time <t>      frame: when, as 90, 1:30 or 1:02:03                [0]
  -w, --width <px>    frame: maximum width, 160–1920                    [1280]
      --audio         media: the audio only (M4A)
      --json          llms, check, parse, report, generate: the whole answer as JSON (parse: the parsed file)
      --base <url>    check, parse a file or -: its public URL, to resolve relative links
      --links         check a file or -: also check its links (and llms-full.txt next to --base)
      --parent <p>    notion: the parent page, an ID or URL (shared with your Notion connection)
      --title <t>     notion: the page title                            [the file's title]
      --token <t>     notion: Notion connection token (or NOTION_TOKEN); never printed
      --quiet         nothing on stderr but errors
      --api <url>     API base URL (or LLMS_INK_API)                    [${DEFAULT_API}]
      --key <key>     API key for higher limits (or LLMS_INK_KEY); optional
  -h, --help          this help
  -v, --version       the version

Examples
  llms-ink developers.cloudflare.com/kv/
  llms-ink github.com/honojs/hono --full -o hono-llms-full.txt
  llms-ink 'https://youtube.com/watch?v=zjkBMFhNj_g' --full | pbcopy
  llms-ink frame 'https://youtu.be/jNQXAC9IVRw' -t 0:12 -o zoo.jpg
  llms-ink example.com --generated -o public/llms.txt
  llms-ink check example.com             exits 1 on errors or broken links
  llms-ink check public/llms.txt --base https://example.com/llms.txt --links
  llms-ink parse llmstxt.org --json
  llms-ink report docs.example.com/guide  robots.txt per AI bot, text without JavaScript, Markdown, llms.txt
  llms-ink generate agents-md github.com/honojs/hono -o AGENTS.md   every line cites its source; review before committing
  llms-ink notion docs.stripe.com/payments --full --parent https://www.notion.so/Research-1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6
  llms-ink context --max 5               docs for the 5 most imported dependencies, AGENTS.md block included

Public links only. 60 new links a day per person; cached links are free.
A free API key raises that to 1000 a day: ask at https://llms.ink/about/#limits`;

/** A message for people: printed without a stack trace. */
export class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/** "90", "90.5", "1:30", "1:02:03" → the same text, checked (the API reads all of these). */
export function parseTime(value) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$|^\d+(?::[0-5]?\d){1,2}(?:\.\d+)?$/.test(text)) throw new CliError('--time: use seconds (90) or minutes:seconds (1:30).', 2);
  return text;
}

export const formatBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** A file name for a link's llms.txt: host and path, made safe. */
export function fileNameFor(url, full) {
  let host = url;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    host = `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`;
  } catch {}
  const safe = host.replace(/[^a-z0-9.-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'llms';
  return `${safe}-${full ? 'llms-full' : 'llms'}.txt`;
}

/** Progress on stderr: one rewritten line on a terminal, a line per step otherwise; nothing with --quiet. */
function reporter(stderr, quiet) {
  let last = '';
  let at = 0;
  const tty = !!stderr.isTTY;
  return {
    say(text) {
      if (quiet || text === last) return;
      const now = Date.now();
      if (text.split('…')[0] === last.split('…')[0] && now - at < (tty ? 80 : 2000)) return;
      last = text;
      at = now;
      stderr.write(tty ? `\r\x1b[2K${text}` : `${text}\n`);
    },
    done(text) {
      if (quiet) return;
      if (tty) stderr.write(`\r\x1b[2K${text ? `${text}\n` : ''}`);
      else if (text) stderr.write(`${text}\n`);
      last = '';
    },
  };
}

/** `key`: optional API key, sent as `Authorization: Bearer`. */
function client(api, key, fetchImpl) {
  const base = api.replace(/\/+$/, '');
  const headers = { accept: 'application/json, */*', ...(key && { authorization: `Bearer ${key}` }) };
  async function call(path, init = {}) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    } catch {
      throw new CliError(`Couldn’t reach ${base}. Check your connection.`);
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new CliError(data?.detail || `${res.status} ${res.statusText || 'error'} from ${path.split('?')[0]}`);
    }
    return res;
  }
  return { base, call };
}

/** Where to write `name`: -o file, -o folder (existing or ending in /), or the current folder. */
async function target(output, name, cwd) {
  if (!output) return join(cwd, name);
  const path = resolve(cwd, output);
  const isDir = output.endsWith('/') || (await stat(path).then((s) => s.isDirectory(), () => false));
  return isDir ? join(path, name) : path;
}

/** Shows the seconds while the server works (building can take a while for big sites and videos). */
function ticking(progress, label) {
  const started = Date.now();
  const tick = () => progress.say(`${label}… ${((Date.now() - started) / 1000).toFixed(0)}s`);
  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}

/** The name a download asks for (content-disposition), else `fallback`. */
function dispositionName(res, fallback) {
  const header = res.headers.get('content-disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) return basename(decodeURIComponent(star[1]));
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? basename(plain[1]) : fallback;
}

async function save(res, dest, progress, stdout) {
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  const count = new Transform({
    transform(chunk, _enc, done) {
      got += chunk.length;
      progress.say(`Saving… ${formatBytes(got)}${total ? ` of ${formatBytes(total)} (${Math.floor((got / total) * 100)}%)` : ''}`);
      done(null, chunk);
    },
  });
  const body = Readable.fromWeb(res.body);
  if (dest === '-') {
    await pipeline(body, count, stdout, { end: false });
    return got;
  }
  await mkdir(dirname(dest), { recursive: true });
  const partial = `${dest}.part`;
  try {
    await pipeline(body, count, createWriteStream(partial));
    await rename(partial, dest);
  } catch (err) {
    await rm(partial, { force: true });
    throw new CliError(`Saving failed: ${err.message}`);
  }
  return got;
}

/** /api/v0/llms's answer for `url` (--full, --fresh and --generated apply), showing the seconds while the server works. */
async function readLlms(api, url, values, ctx) {
  const params = new URLSearchParams({ url, mode: values.full ? 'full' : 'llms' });
  if (values.fresh) params.set('fresh', '1');
  if (values.generated) params.set('native', '0');
  const stop = ticking(ctx.progress, `Inking ${url}${values.full ? ' (full)' : ''}`);
  let result;
  try {
    const res = await api.call(`/api/v0/llms?${params}`);
    result = await res.json().catch(() => null);
  } finally {
    stop();
  }
  if (!result || typeof result.text !== 'string') throw new CliError('Unexpected answer from /api/llms.');
  return result;
}

async function cmdLlms(api, url, values, ctx) {
  const result = await readLlms(api, url, values, ctx);
  const summary = [result.kind, result.source, `${result.tokens.toLocaleString('en-US')} tokens`, `${result.pages} ${result.mode === 'full' ? 'pages' : 'links'}`, result.cached ? 'cached' : null].filter(Boolean).join(' · ');
  if (values.json) {
    ctx.progress.done('');
    return writeOut(JSON.stringify(result, null, 2), values, fileNameFor(url, values.full).replace(/\.txt$/, '.json'), ctx, summary);
  }
  ctx.progress.done('');
  await writeOut(result.text, values, fileNameFor(url, values.full), ctx, summary);
}

/** Saves a link's llms.txt (llms-full.txt with --full) as a Notion page under --parent; prints the page URL. The token is never printed. */
async function cmdNotion(api, url, values, ctx) {
  const { NotionError, markdownToPage, notionPageId, saveToNotion } = await import('./notion.js');
  if (values.parent === undefined) throw new CliError('Give the parent page: llms-ink notion <link> --parent <page-id-or-url>', 2);
  const parent = notionPageId(values.parent);
  if (!parent) throw new CliError('--parent: a Notion page ID or URL (in Notion: Share → Copy link).', 2);
  const token = (values.token ?? ctx.env.NOTION_TOKEN)?.trim();
  if (!token) throw new CliError('Set NOTION_TOKEN to your Notion connection’s token (or pass --token), and share the parent page with that connection. Create one at https://app.notion.com/developers/connections', 2);
  const result = await readLlms(api, url, values, ctx);
  const { title, blocks } = markdownToPage(result.text, { title: values.title ?? result.title, source: result.url ?? url });
  ctx.progress.say('Saving to Notion…');
  let page;
  try {
    page = await saveToNotion({
      token, parent, title, blocks, fetch: ctx.fetch,
      onProgress: ({ done, total }) => ctx.progress.say(`Saving to Notion… ${done} of ${total} blocks`),
      onWait: (seconds) => ctx.progress.say(`Notion asked to wait ${seconds}s…`),
    });
  } catch (err) {
    if (!(err instanceof NotionError)) throw err;
    throw new CliError(err.status === 401 ? `${err.message} Check NOTION_TOKEN or --token.` : err.message);
  }
  ctx.progress.done(`Saved “${title}” to Notion · ${plural(page.blocks, 'block')} · ${plural(page.requests, 'request')}`);
  ctx.out(page.url);
}

/** Text to stdout, or to the file/folder -o names (the path goes to stdout then, for scripts). */
async function writeOut(text, values, name, ctx, summary) {
  const body = text.endsWith('\n') ? text : `${text}\n`;
  if (!values.output || values.output === '-') {
    ctx.stdout.write(body);
    ctx.progress.done(summary);
    return;
  }
  const dest = await target(values.output, name, ctx.cwd);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, body);
  ctx.progress.done(`Saved ${basename(dest)} · ${summary}`);
  if (!ctx.stdout.isTTY) ctx.out(dest);
}

/**
 * A path, not a link: starts with ./, ../, / or ~ (or a drive letter), or has a folder and ends in .txt or .md while
 * its first segment has no dot and no colon (public/llms.txt; example.com/llms.txt and localhost:8787/x.md are links).
 */
export function looksLikePath(arg) {
  if (/^(\.{1,2}[\\/]|[\\/]|~|[a-z]:[\\/])/i.test(arg)) return true;
  const first = arg.split(/[\\/]/)[0];
  return first !== arg && /\.(txt|md)$/i.test(arg) && !/[.:]/.test(first);
}

/** `-` (stdin) or an existing file: checked by sending its text (POST); anything else is a link (GET). */
async function fetchCheck(api, arg, values, ctx, verb) {
  const local = arg === '-' || (await stat(resolve(ctx.cwd, arg)).then((s) => s.isFile(), () => false));
  if (!local && looksLikePath(arg)) throw new CliError(`No such file: ${arg}`, 2);
  if (!local && (values.base !== undefined || values.links)) throw new CliError('--base and --links are for a file or - (stdin), not a link.', 2);
  const label = arg === '-' ? 'stdin' : arg;
  let request;
  if (local) {
    const text = arg === '-' ? await readAll(ctx.stdin) : await readFile(resolve(ctx.cwd, arg), 'utf8');
    const params = new URLSearchParams();
    if (values.base !== undefined) params.set('base', values.base);
    if (values.links) params.set('links', '1');
    request = [`/api/v0/check${params.size ? `?${params}` : ''}`, { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: text }];
  } else {
    request = [`/api/v0/check?${new URLSearchParams({ url: arg })}`];
  }
  const stop = ticking(ctx.progress, `${verb} ${label}`);
  let r;
  try {
    const res = await api.call(...request);
    r = await res.json().catch(() => null);
  } finally {
    stop();
  }
  if (!r?.summary || !Array.isArray(r.issues) || !Array.isArray(r.links?.broken)) throw new CliError('Unexpected answer from /api/check.');
  ctx.progress.done('');
  return { r, label };
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The checks as text: a summary line, then each issue. Exits 1 on errors or broken links, else 0. */
async function cmdCheck(api, arg, values, ctx) {
  const { r, label } = await fetchCheck(api, arg, values, ctx, 'Checking');
  if (values.json) {
    ctx.out(JSON.stringify(r, null, 2));
  } else {
    const full = r.llmsFull === null || r.llmsFull === undefined ? 'not checked' : r.llmsFull ? 'found' : 'not found';
    const head = r.found
      ? `${r.url ?? label}: ${plural(r.summary.errors, 'error')}, ${plural(r.summary.warnings, 'warning')} · ${plural(r.sections, 'section')} · ${plural(r.links.total, 'link')} (${r.links.checked} checked, ${r.links.broken.length} broken) · ~${r.tokens} tokens · llms-full.txt ${full}`
      : `No llms.txt found for ${r.site ?? label}.`;
    const issues = r.issues.map((i) => `- ${i.level}${i.line ? ` (line ${i.line})` : ''}: ${i.message}`);
    const broken = r.links.broken.map((b) => `- ${b.url} (${b.status ? `HTTP ${b.status}` : 'no answer'})`);
    ctx.out([head, ...(issues.length ? ['', ...issues] : []), ...(broken.length ? ['', 'Broken links:', ...broken] : [])].join('\n'));
  }
  return r.summary.errors > 0 || r.links.broken.length > 0 ? 1 : 0;
}

/** The parsed llms.txt: title, summary, then each section and its links. Exits 1 when there's no llms.txt or no title. */
async function cmdParse(api, arg, values, ctx) {
  const { r, label } = await fetchCheck(api, arg, values, ctx, 'Parsing');
  if (r.parsed === undefined) throw new CliError('This API doesn’t parse llms.txt yet (no “parsed” in its answer).');
  const p = r.parsed;
  if (values.json) {
    ctx.out(JSON.stringify(p, null, 2));
    return p?.title ? 0 : 1;
  }
  if (!r.found) throw new CliError(`No llms.txt found for ${r.site ?? label}.`);
  if (!p?.title) throw new CliError(`${label} has no title (a “# ” heading), so it isn’t an llms.txt.`);
  const lines = [p.title, ...(p.summary ? [p.summary] : [])];
  for (const s of p.sections) {
    lines.push('', `${s.name} · ${plural(s.links.length, 'link')}${s.optional ? ' · optional' : ''}`);
    for (const l of s.links) lines.push(`- ${l.title}  ${l.url}`);
  }
  ctx.out(lines.join('\n'));
  return 0;
}

const MARK = { fail: '✕', warn: '!', info: '·', pass: '✓' };
const ORDER = { fail: 0, warn: 1, info: 2, pass: 3 };

/** The agent's-eye report: a summary line and the share link, then each section's checks (problems first, with their fixes). Exits 1 on any fail. */
async function cmdReport(api, url, values, ctx) {
  const stop = ticking(ctx.progress, `Reading ${url} the way AI agents do`);
  let r;
  try {
    const res = await api.call(`/api/v0/report?${new URLSearchParams({ url })}`);
    r = await res.json().catch(() => null);
  } finally {
    stop();
  }
  if (!r?.summary || !Array.isArray(r.sections)) throw new CliError('Unexpected answer from /api/v0/report.');
  ctx.progress.done('');
  if (values.json) {
    ctx.out(JSON.stringify(r, null, 2));
  } else {
    const { fail, warn, pass, info } = r.summary;
    const lines = [`${r.url}: ${fail} fail, ${warn} warn, ${pass} pass, ${info} info`, `Share: ${api.base}/report/?${new URLSearchParams({ url: r.url })}`];
    for (const s of r.sections) {
      lines.push('', s.title);
      for (const c of [...s.checks].sort((a, b) => ORDER[a.status] - ORDER[b.status])) {
        lines.push(`  ${MARK[c.status] ?? '·'} ${c.status.padEnd(4)}  ${c.title}: ${c.detail}`);
        if (c.fix && c.status !== 'pass') lines.push(`          fix: ${c.fix.summary}${c.fix.patch ? ` (--json has the new ${c.fix.patch.file})` : ''}`);
      }
    }
    ctx.out(lines.join('\n'));
  }
  return r.summary.fail > 0 ? 1 : 0;
}

const KINDS = ['agents-md', 'jsonld', 'alt-text', 'answers'];

/** Drafts as files people can use: AGENTS.md, a JSON-LD array, alt="…" per image, or answer-first sections. Notes go to stderr. */
async function cmdGenerate(api, kind, url, values, ctx) {
  if (!KINDS.includes(kind)) throw new CliError(`Unknown kind “${kind}”: use ${KINDS.join(', ')}.`, 2);
  const params = new URLSearchParams({ url, kind });
  if (values.fresh) params.set('fresh', '1');
  const stop = ticking(ctx.progress, `Drafting ${kind} for ${url}`);
  let r;
  try {
    const res = await api.call(`/api/v0/generate?${params}`);
    r = await res.json().catch(() => null);
  } finally {
    stop();
  }
  if (!Array.isArray(r?.drafts) || !Array.isArray(r.notes)) throw new CliError('Unexpected answer from /api/v0/generate.');
  const host = fileNameFor(r.url ?? url, false).replace(/-llms\.txt$/, '');
  const summary = [`${plural(r.drafts.length, 'draft')} · ${r.model ? `written by ${r.model}` : 'extracted, no model'}${r.cached ? ' · cached' : ''}`, ...r.notes.map((n) => `  ${n}`)].join('\n');
  ctx.progress.done('');
  if (values.json) return writeOut(JSON.stringify(r, null, 2), values, `${kind}-${host}.json`, ctx, summary);
  if (!r.drafts.length) {
    ctx.progress.done(summary);
    return 0;
  }
  const text = {
    'agents-md': () => r.drafts[0].content,
    jsonld: () => JSON.stringify(r.drafts.map((d) => JSON.parse(d.content)), null, 2),
    'alt-text': () => r.drafts.map((d) => `${d.target}\n  alt="${d.content.replace(/"/g, '&quot;')}"`).join('\n'),
    answers: () => r.drafts.map((d) => `<!-- was: ## ${d.target} -->\n${d.content.trimEnd()}`).join('\n\n'),
  }[kind]();
  const names = { 'agents-md': 'AGENTS.md', jsonld: `jsonld-${host}.json`, 'alt-text': `alt-text-${host}.txt`, answers: `answers-${host}.md` };
  return writeOut(text, values, names[kind], ctx, summary);
}

async function cmdFrame(api, url, values, ctx) {
  const params = new URLSearchParams({ url, t: values.time === undefined ? '0' : parseTime(values.time) });
  if (values.width !== undefined) {
    const w = Number(values.width);
    if (!Number.isInteger(w) || w < 160 || w > 1920) throw new CliError('--width: a number from 160 to 1920.', 2);
    params.set('w', String(w));
  }
  const stop = ticking(ctx.progress, 'Grabbing the frame');
  let res;
  try { res = await api.call(`/api/v0/frame?${params}`); } finally { stop(); }
  const name = dispositionName(res, `frame-${params.get('t').replace(/:/g, '-')}.jpg`);
  const dest = values.output === '-' ? '-' : await target(values.output, name, ctx.cwd);
  const bytes = await save(res, dest, ctx.progress, ctx.stdout);
  ctx.progress.done(dest === '-' ? '' : `Saved ${basename(dest)} · ${formatBytes(bytes)}`);
  if (dest !== '-' && !ctx.stdout.isTTY) ctx.out(dest);
}

async function cmdMedia(api, url, values, ctx) {
  const params = new URLSearchParams({ url, format: values.audio ? 'm4a' : 'mp4' });
  const stop = ticking(ctx.progress, `Preparing the ${values.audio ? 'audio' : 'video'}`);
  let res;
  try { res = await api.call(`/api/v0/media?${params}`); } finally { stop(); }
  const name = dispositionName(res, values.audio ? 'audio.m4a' : 'video.mp4');
  const dest = values.output === '-' ? '-' : await target(values.output, name, ctx.cwd);
  const bytes = await save(res, dest, ctx.progress, ctx.stdout);
  ctx.progress.done(dest === '-' ? '' : `Saved ${basename(dest)} · ${formatBytes(bytes)}`);
  if (dest !== '-' && !ctx.stdout.isTTY) ctx.out(dest);
}

/**
 * Runs the CLI. `io` is injectable for tests: argv, env, cwd, stdout/stderr streams and fetch.
 * Returns the exit code: 0 done, 1 failed, 2 wrong usage.
 */
export async function main(io = {}) {
  const argv = io.argv ?? process.argv.slice(2);
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const out = (text) => stdout.write(`${text}\n`);
  try {
    if (argv[0] === 'inspect') {
      const { cmdInspect } = await import('./inspect.js');
      return await cmdInspect(argv.slice(1), { env, stdout, stderr, cwd: io.cwd ?? process.cwd(), fetch: io.fetch ?? fetch, signal: io.signal });
    }
    if (argv[0] === 'context') {
      const { cmdContext } = await import('./context/index.js');
      return await cmdContext(argv.slice(1), { env, stdout, stderr, cwd: io.cwd ?? process.cwd(), fetch: io.fetch ?? fetch, client, reporter });
    }
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          full: { type: 'boolean' }, fresh: { type: 'boolean' }, output: { type: 'string', short: 'o' },
          time: { type: 'string', short: 't' }, width: { type: 'string', short: 'w' }, audio: { type: 'boolean' },
          json: { type: 'boolean' }, quiet: { type: 'boolean' }, api: { type: 'string' }, key: { type: 'string' }, generated: { type: 'boolean' },
          base: { type: 'string' }, links: { type: 'boolean' }, parent: { type: 'string' }, title: { type: 'string' }, token: { type: 'string' },
          help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
        },
      });
    } catch (err) {
      throw new CliError(`${err.message.replace(/\. To specify.*$/, '')}\nRun llms-ink --help for the options.`, 2);
    }
    const { values, positionals } = parsed;
    if (values.version) { out(VERSION); return 0; }
    if (values.help || positionals.length === 0) {
      (values.help ? stdout : stderr).write(`${HELP}\n`);
      return values.help ? 0 : 2;
    }
    let kind;
    const commands = { frame: cmdFrame, media: cmdMedia, check: cmdCheck, parse: cmdParse, report: cmdReport, llms: cmdLlms, notion: cmdNotion, generate: (a, link, v, c) => cmdGenerate(a, kind, link, v, c) };
    let [command, url, ...rest] = positionals;
    if (!Object.hasOwn(commands, command)) [command, url, rest] = ['llms', positionals[0], positionals.slice(1)];
    if (command === 'generate') [kind, url, ...rest] = [url, ...rest];
    const what = { check: 'a site, a file or -: llms-ink check <site|file|->', parse: 'a file, - or a link: llms-ink parse <file|-|link>', generate: `a kind and a link: llms-ink generate <${KINDS.join('|')}> <link>`, notion: 'a link: llms-ink notion <link> --parent <page-id-or-url>' }[command];
    if (!url) throw new CliError(what ? `Give ${what}` : `Give a link: llms-ink ${command === 'llms' ? '' : `${command} `}<link>`, 2);
    if (rest.length) throw new CliError(`One link at a time (got “${rest[0]}” too).`, 2);
    const reads = command === 'check' || command === 'parse' || command === 'report';
    if (command !== 'llms' && command !== 'notion' && (values.full || (values.fresh && command !== 'generate') || values.generated)) throw new CliError(`--full, --fresh and --generated are for llms.txt, not ${command}.`, 2);
    if (command !== 'llms' && command !== 'generate' && !reads && values.json) throw new CliError(`--json is for llms.txt, check, parse, report and generate, not ${command}.`, 2);
    if (reads && values.output !== undefined) throw new CliError(`${command} prints its report; redirect it to save it.`, 2);
    if (command !== 'check' && command !== 'parse' && values.base !== undefined) throw new CliError('--base is for check and parse.', 2);
    if (command !== 'check' && values.links) throw new CliError('--links is for check.', 2);
    if (command !== 'frame' && (values.time !== undefined || values.width !== undefined)) throw new CliError('--time and --width are for frame.', 2);
    if (command !== 'media' && values.audio) throw new CliError('--audio is for media.', 2);
    if (command !== 'notion' && (values.parent !== undefined || values.title !== undefined || values.token !== undefined)) throw new CliError('--parent, --title and --token are for notion.', 2);
    if (command === 'notion' && values.output !== undefined) throw new CliError('notion saves to Notion and prints the page URL; -o isn’t used.', 2);
    const api = client(values.api ?? env.LLMS_INK_API ?? DEFAULT_API, (values.key ?? env.LLMS_INK_KEY)?.trim(), io.fetch ?? fetch);
    const ctx = { out, env, fetch: io.fetch ?? fetch, stdout, stdin: io.stdin ?? process.stdin, cwd: io.cwd ?? process.cwd(), progress: reporter(stderr, !!values.quiet) };
    return (await commands[command](api, url, values, ctx)) ?? 0;
  } catch (err) {
    if (err instanceof CliError) {
      stderr.write(`${stderr.isTTY ? '\r\x1b[2K' : ''}llms-ink: ${err.message}\n`);
      return err.code;
    }
    stderr.write(`llms-ink: ${err?.stack ?? err}\n`);
    return 1;
  }
}
