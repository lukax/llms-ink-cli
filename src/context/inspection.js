// Explicit pack upload and offline byte/receipt verification. Records are unsigned;
// they never grant tool authority or establish that reference content is safe.
import { lstat, readdir, realpath, open, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { inspectionJson, inspectionReceipt, prepareInspection } from '../inspect-contract.js';
import { outputDirectory, readOutput } from './files.js';
import { fileName, readFrontMatter } from './output.js';

const ENDPOINT = 'https://llms.ink/api/v0/inspect';
const SCHEMA = 'llms-ink-context-inspection-1';
const FILE_LIMIT = 64, BODY_LIMIT = 8 * 1024 * 1024;
const posix = path => path.split(sep).join('/');
class InputError extends Error {}
const HELP = `Usage:
  llms-ink context inspect --dir .context --dry-run
  llms-ink context inspect --dir .context --output context-inspection.json
  llms-ink context verify --dir .context --receipt context-inspection.json

Preview lists files without uploading. Inspect sends every .md, .txt and .json
file under the selected directory as exact UTF-8 text, including local notes.
Other file types, symlinks and hard links are refused before any upload.
Generate first with llms-ink context; generation never starts inspection.

  --dir <path>       explicit directory inside the current folder
  --dry-run          inspect only: preview metadata; no key or network needed
  -o, --output <p>   inspect only: new private manifest outside the selected pack
  --receipt <path>   verify only: existing manifest to check offline
  --quiet            suppress the summary on stderr
  -h, --help         show this help

Set LLMS_INK_INSPECT_KEY (or LLMS_INK_KEY) for uploads. The API origin is fixed.
64 files maximum; 128 KiB per encoded request; 8 MiB total. The service also
limits each file to 8,192 tokens. Requests wait 7 seconds between files, with
no automatic retries. Failure or cancellation preserves partial results.
Existing manifests are never overwritten. Keep sensitive filenames/URLs private.

Verify checks the full file set, exact bytes and supported receipt revisions.
Unsigned receipts can be forged: trust the producer and protect the manifest.
No finding is not a safety guarantee; local freshness is not upstream freshness.
0 = current, complete/no finding (or preview); 1 = withhold/stale/invalid result;
2 = invalid input/setup. Any nonzero exit must stop downstream delivery.
`;

function inside(root, value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || /[\\\x00-\x1f\x7f*?\[\]]/.test(value)
      || value.split('/').some(part => part === '..' || part === '.git'))
    throw new InputError('Use an explicit relative path inside the current folder; no globs, parent paths or .git.');
  const target = resolve(root, value), rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new InputError('Select a path inside the current folder, not the folder itself.');
  return target;
}

function provenance(text) {
  const fm = readFrontMatter(text);
  if (!fm) return null;
  fileName(fm.package, fm.version);
  if (!['npm', 'pypi', 'crates', 'go'].includes(fm.ecosystem) || !['pinned', 'unpinned'].includes(fm.docs)
      || !Array.isArray(fm.sources) || !fm.sources.length || fm.sources.length > 8)
    throw new InputError('Invalid declared package metadata in the selected pack.');
  for (const source of fm.sources) {
    if (typeof source !== 'string' || source.length > 2048 || /[\x00-\x20\x7f]/.test(source)) throw new InputError('Invalid declared source URL.');
    const url = new URL(source);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new InputError('Invalid declared source URL.');
  }
  return { package: fm.package, ecosystem: fm.ecosystem, version: fm.version, docs: fm.docs, sources: fm.sources };
}

/** Snapshot every file, not just files with generator metadata. No uploads here. */
export async function snapshotPack(root, dir) {
  const target = inside(root, dir);
  if (!await outputDirectory(target)) throw new InputError('The selected context directory does not exist.');
  const files = []; let directories = 0, total = 0;
  async function walk(path, depth) {
    if (++directories > 128 || depth > 32) throw new InputError('The pack exceeds 128 directories or 32 directory levels.');
    const names = (await readdir(path)).sort();
    if (names.length > 192) throw new InputError('The selected directory has too many entries.');
    for (const name of names) {
      const full = join(path, name), rel = posix(relative(target, full));
      inside(root, posix(relative(root, full)));
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new InputError('Inspection refuses symlinks in the selected pack.');
      if (info.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!info.isFile() || info.nlink !== 1 || !/\.(md|txt|json)$/i.test(name))
        throw new InputError('Every pack entry must be an ordinary .md, .txt or .json file, without hard links.');
      if (files.length >= FILE_LIMIT || info.size > 131072) throw new InputError('The pack exceeds 64 files or 128 KiB per file.');
      const text = await readOutput(full);
      if (text === null) throw new InputError('A selected pack file disappeared.');
      let prepared;
      try { prepared = await prepareInspection(text, ENDPOINT); }
      catch { throw new InputError('A pack file is empty, invalid UTF-8 or exceeds 128 KiB after JSON encoding.'); }
      total += Buffer.byteLength(prepared.body);
      if (total > BODY_LIMIT) throw new InputError('The pack exceeds 8 MiB of encoded request bodies.');
      files.push({ path: rel, bytes: Buffer.byteLength(text), sha256: prepared.digest, source: provenance(text), body: prepared.body });
    }
  }
  await walk(target, 0);
  if (!files.length) throw new InputError('The selected context pack is empty.');
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { directory: posix(relative(root, target)), files, requestBytes: total };
}
const metadata = ({ path, bytes, sha256, source }) => ({ path, bytes, sha256, source });
const sameFiles = (a, b) => JSON.stringify(a.map(metadata)) === JSON.stringify(b.map(metadata));
const unattempted = () => ({ state: 'not_attempted', httpStatus: null, receipt: null });
const failed = (reason, httpStatus = null) => ({ state: 'failed', reason, httpStatus, receipt: null });

async function request(file, io, key) {
  const controller = new AbortController(), abort = () => controller.abort();
  const timer = setTimeout(abort, 65000);
  io.signal?.addEventListener('abort', abort, { once: true });
  if (io.signal?.aborted) abort();
  try {
    if (controller.signal.aborted) return failed('cancelled');
    const response = await io.fetch(ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'application/json' }, body: file.body });
    if (![200, 422, 503].includes(response.status)) {
      await response.body?.cancel();
      return failed('http_error', response.status);
    }
    const receipt = inspectionReceipt(await inspectionJson(response), file.sha256, response.status);
    return { state: 'received', httpStatus: response.status, receipt };
  } catch {
    return failed(io.signal?.aborted ? 'cancelled' : 'request_or_receipt_failed');
  } finally { clearTimeout(timer); io.signal?.removeEventListener('abort', abort); }
}

function validRecord(record, snapshot) {
  if (!record || record.schema !== SCHEMA || record.endpoint !== ENDPOINT || record.representation !== 'utf8-exact-text'
      || typeof record.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.createdAt)
      || !Number.isFinite(Date.parse(record.createdAt)) || !['complete', 'interrupted'].includes(record.runState) || record.directory !== snapshot.directory
      || !Array.isArray(record.files) || !record.files.length || record.files.length > FILE_LIMIT) throw new Error('Invalid manifest.');
  const seen = new Set();
  for (const file of record.files) {
    if (!file || typeof file.path !== 'string' || seen.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 131072
        || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256) || !Object.hasOwn(file, 'source')) throw new Error('Invalid file record.');
    seen.add(file.path);
    const scan = file.inspection;
    if (!scan || !['received', 'failed', 'not_attempted'].includes(scan.state)) throw new Error('Invalid inspection record.');
    if (scan.state === 'received') inspectionReceipt(scan.receipt, file.sha256, scan.httpStatus);
    else if (scan.receipt !== null || (scan.state === 'not_attempted' && scan.httpStatus !== null)
        || (scan.state === 'failed' && (!['cancelled', 'http_error', 'request_or_receipt_failed'].includes(scan.reason)
          || !(scan.httpStatus === null || (Number.isInteger(scan.httpStatus) && scan.httpStatus >= 100 && scan.httpStatus <= 599)))))
      throw new Error('Invalid incomplete record.');
  }
}

function result(record, current) {
  const counts = { noFinding: 0, flagged: 0, unknown: 0, notAttempted: 0 };
  for (const file of record.files) {
    const scan = file.inspection;
    if (scan.state === 'not_attempted') counts.notAttempted++;
    else if (scan.receipt?.detection === 'no_finding') counts.noFinding++;
    else if (scan.receipt?.detection === 'flagged') counts.flagged++;
    else counts.unknown++;
  }
  const pass = current && record.runState === 'complete' && counts.noFinding === record.files.length;
  return { status: current ? 'current' : 'stale', runState: record.runState, files: record.files.length, ...counts, recommendation: pass ? 'continue' : 'withhold', unsigned: true };
}

export async function cmdContextInspection(mode, argv, io) {
  let temp, handle;
  try {
    let values;
    try { ({ values } = parseArgs({ args: argv, allowPositionals: false, options: { dir: { type: 'string' },
      output: { type: 'string', short: 'o' }, receipt: { type: 'string' }, 'dry-run': { type: 'boolean' },
      quiet: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } })); }
    catch { throw new InputError('Invalid context inspection options. Run llms-ink context inspect --help.'); }
    if (values.help) { io.stdout.write(HELP); return 0; }
    if (!values.dir || (mode === 'verify' ? !values.receipt || values.output || values['dry-run'] : values.receipt || (!values.output && !values['dry-run'])))
      throw new InputError('Specify --dir and the command-specific --output or --receipt; use --dry-run to preview an inspection.');
    const root = await realpath(io.cwd);
    let key, dest;
    if (mode === 'inspect' && !values['dry-run']) {
      key = (io.env.LLMS_INK_INSPECT_KEY ?? io.env.LLMS_INK_KEY ?? '').trim();
      if (!/^lk_[A-Za-z0-9]{32}$/.test(key)) throw new InputError('Set LLMS_INK_INSPECT_KEY to an inspection-enabled key.');
      dest = inside(root, values.output);
      const pack = inside(root, values.dir), rel = relative(pack, dest);
      if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))) throw new InputError('The manifest output must be outside the selected pack.');
      if (!await outputDirectory(dirname(dest)) || await readOutput(dest) !== null) throw new InputError('Output must be a new file in an existing directory.');
    }
    const snapshot = await snapshotPack(root, values.dir);
    if (values['dry-run']) {
      io.stdout.write(JSON.stringify({ directory: snapshot.directory, requestBytes: snapshot.requestBytes, files: snapshot.files.map(metadata), uploads: 0 }, null, 2) + '\n');
      return 0;
    }
    if (mode === 'verify') {
      let record;
      try {
        const raw = await readOutput(inside(root, values.receipt));
        if (raw === null || Buffer.byteLength(raw) > 1048576) throw new Error('Missing or oversized manifest.');
        record = JSON.parse(raw); validRecord(record, snapshot);
      } catch {
        io.stdout.write(JSON.stringify({ status: 'invalid', recommendation: 'withhold', unsigned: true }) + '\n');
        return 1;
      }
      const summary = result(record, sameFiles(snapshot.files, record.files));
      io.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      if (!values.quiet) io.stderr.write(`Context inspection: ${summary.status}; ${summary.recommendation}. Unsigned record, not a safety guarantee.\n`);
      return summary.recommendation === 'continue' ? 0 : 1;
    }
    temp = join(dirname(dest), '.llms-context-inspect-' + randomUUID() + '.tmp');
    handle = await open(temp, 'wx', 0o600);
    const record = { schema: SCHEMA, createdAt: new Date().toISOString(), endpoint: ENDPOINT,
      representation: 'utf8-exact-text', directory: snapshot.directory, runState: 'interrupted',
      files: snapshot.files.map(file => ({ ...metadata(file), inspection: unattempted() })) };
    for (let i = 0; i < snapshot.files.length; i++) {
      if (io.signal?.aborted) break;
      if (i) {
        try { await (io.sleep ?? sleep)(7000, undefined, { signal: io.signal }); }
        catch { break; }
      }
      if (io.signal?.aborted) break;
      const scan = await request(snapshot.files[i], io, key);
      record.files[i].inspection = scan;
      if (!values.quiet) io.stderr.write(`Inspected ${i + 1}/${record.files.length}: ${scan.receipt?.detection ?? 'unknown'}.\n`);
      if (scan.state !== 'received' || scan.httpStatus === 503) break;
    }
    record.runState = io.signal?.aborted || record.files.some(file => file.inspection.state !== 'received') ? 'interrupted' : 'complete';
    let current = false;
    try { current = sameFiles(snapshot.files, (await snapshotPack(root, values.dir)).files); } catch { /* Preserve the original submitted snapshot. */ }
    if (io.signal?.aborted) record.runState = 'interrupted';
    const summary = result(record, current);
    // A cancelled run cannot report success, even if cancellation arrived after
    // the final response. Earlier valid receipts remain available for review.
    if (io.signal?.aborted) summary.recommendation = 'withhold';
    await handle.writeFile(JSON.stringify(record, null, 2) + '\n'); await handle.sync(); await handle.close(); handle = undefined;
    if (!await outputDirectory(dirname(dest)) || await readOutput(dest) !== null) throw new Error('Output changed.');
    await link(temp, dest);
    io.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    if (!values.quiet) io.stderr.write(`Context inspection: ${summary.status}; ${summary.recommendation}. Unsigned record, not a safety guarantee.\n`);
    return summary.recommendation === 'continue' ? 0 : 1;
  } catch (error) {
    if (error instanceof InputError) { io.stderr.write('llms-ink: ' + error.message + '\n'); return 2; }
    io.stderr.write('llms-ink: Context inspection could not complete. Check paths, UTF-8 and metadata; withhold the pack.\n');
    return 1;
  } finally { await handle?.close().catch(() => {}); if (temp) await unlink(temp).catch(() => {}); }
}
