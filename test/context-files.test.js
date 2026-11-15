import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('context publication respects creation permissions and preserves existing file mode', { skip: process.platform === 'win32' }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-context-mode-')));
  try {
    const module = new URL('../src/context/files.js', import.meta.url).href;
    const script = `import {writeIfChanged} from ${JSON.stringify(module)};
import {chmod} from 'node:fs/promises';import {join} from 'node:path';
process.umask(0o027);
await writeIfChanged(join(process.argv[1],'new.md'),'new');
await writeIfChanged(join(process.argv[1],'existing.md'),'before');
await chmod(join(process.argv[1],'existing.md'),0o600);
await writeIfChanged(join(process.argv[1],'existing.md'),'after');`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script, root]);
    assert.equal((await stat(join(root, 'new.md'))).mode & 0o777, 0o640);
    assert.equal((await stat(join(root, 'existing.md'))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(root, 'existing.md'), 'utf8'), 'after');
  } finally { await rm(root, { recursive: true, force: true }); }
});
