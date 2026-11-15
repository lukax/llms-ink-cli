// Context output paths are checked before network work and again at publication.
// This handles repository-supplied links; it is not isolation from a process
// concurrently replacing parent directories under the same OS account.
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, link, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_FILE = 8 * 1024 * 1024;
export function validateOutputContent(content) {
  if (Buffer.byteLength(content) > MAX_FILE) throw new Error('A generated context output exceeds 8 MiB. Reduce --tokens or --max.');
}
const invalid = () => new Error('Context output paths must use regular files and directories, without symlinks or hard links.');
const changed = () => new Error('A context output changed during the run. No further files were written; review it and rerun.');
async function state(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function outputDirectory(path, create = false) {
  const absolute = resolve(path), root = parse(absolute).root;
  let at = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    at = join(at, part);
    let info = await state(at);
    if (!info && create) {
      try { await mkdir(at); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      info = await state(at);
    }
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
  }
  return true;
}

export async function readOutput(path) {
  if (!await outputDirectory(dirname(path))) return null;
  const before = await state(path);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw invalid();
  if (before.size > MAX_FILE) throw new Error('An existing context output exceeds 8 MiB. Review it before rerunning.');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const start = await file.stat();
    if (!start.isFile() || start.ino !== before.ino || start.dev !== before.dev || start.nlink !== 1
        || start.size !== before.size || start.mtimeMs !== before.mtimeMs || start.ctimeMs !== before.ctimeMs) throw changed();
    const buffer = Buffer.alloc(Math.min(MAX_FILE + 1, start.size + 1)); let bytes = 0;
    while (bytes < buffer.length) {
      const next = await file.read(buffer, bytes, buffer.length - bytes, null);
      if (!next.bytesRead) break;
      bytes += next.bytesRead;
    }
    const end = await file.stat(), current = await state(path);
    if (bytes > MAX_FILE || end.size !== start.size || end.mtimeMs !== start.mtimeMs || end.ctimeMs !== start.ctimeMs
        || !current || current.ino !== start.ino || current.dev !== start.dev || current.isSymbolicLink()
        || await realpath(path) !== resolve(path)) throw changed();
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes));
  } finally { await file.close(); }
}

export async function writeIfChanged(path, content, expected) {
  const before = await readOutput(path);
  if (arguments.length >= 3 && before !== expected) throw changed();
  if (before === content) return 'unchanged';
  validateOutputContent(content);
  await outputDirectory(dirname(path), true);
  const original = await state(path);
  const temp = join(dirname(path), '.llms-context-' + randomUUID() + '.tmp');
  // Let open apply the creation mask atomically. Reading process.umask() would
  // temporarily change the process-wide mask and can race other threads.
  const file = await open(temp, 'wx', original ? original.mode & 0o777 : 0o666);
  try {
    await file.writeFile(content); await file.sync();
    if (original) await file.chmod(original.mode & 0o777);
    await file.close();
    if (await readOutput(path) !== before) throw changed();
    const current = await state(path);
    if (original ? !current || current.ino !== original.ino || current.dev !== original.dev : current !== null) throw changed();
    if (original) await rename(temp, path);
    else await link(temp, path); // A concurrent creator is never overwritten.
    return before === null ? 'created' : 'updated';
  } finally { await file.close().catch(() => {}); await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function removeFile(path, expected) {
  const before = await readOutput(path);
  if (arguments.length >= 2 && before !== expected) throw changed();
  if (before !== null) await unlink(path);
}
