import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Writable } from 'node:stream';
import { main } from '../src/cli.js';
import { readFile } from 'node:fs/promises';
import { NOTION_API, NOTION_VERSION, NotionError, markdownToBlocks, markdownToPage, notionLanguage, notionPageId, richText, saveToNotion, splitText } from '../src/notion.js';
import { FULL, startMock } from './mock.js';

const TOKEN = 'ntn_test_secret_0123456789';
const PARENT = '1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6';
const PARENT_ID = '1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6';
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Each block as "type: text" with its children indented: enough to compare structure without the JSON noise. */
function outline(blocks, depth = 0) {
  return blocks.flatMap((b) => {
    const v = b[b.type];
    const text = (v.rich_text ?? []).map((r) => r.text.content).join('');
    return [`${'  '.repeat(depth)}${b.type}${v.checked === undefined ? '' : v.checked ? ' [x]' : ' [ ]'}: ${text}`, ...outline(v.children ?? [], depth + 1)];
  });
}

const kids = (b) => b[b.type].children ?? [];
const plain = (rich) => rich.map((r) => r.text.content).join('');

test('lists nest to any depth, as bulleted, numbered and to-do items; headings, quotes and dividers map', () => {
  const md = '# One\n## Two\n### Three\n#### Four\n###### Six\n\nSetext\n---\n\n- a\n  - b\n    - c\n      - d\n- e\n\n1. first\n2. second\n   1. inner\n\n- [ ] open\n- [x] done\n  - [X] sub\n\n> quoted\n> line\n>\n> - in quote\n\n***\n\nText';
  assert.deepEqual(outline(markdownToBlocks(md)), [
    'heading_1: One', 'heading_2: Two', 'heading_3: Three', 'heading_3: Four', 'heading_3: Six', 'heading_2: Setext',
    'bulleted_list_item: a', '  bulleted_list_item: b', '    bulleted_list_item: c', '      bulleted_list_item: d', 'bulleted_list_item: e',
    'numbered_list_item: first', 'numbered_list_item: second', '  numbered_list_item: inner',
    'to_do [ ]: open', 'to_do [x]: done', '  to_do [x]: sub',
    'quote: quoted line', '  bulleted_list_item: in quote',
    'divider: ', 'paragraph: Text',
  ]);
  // Tabs and two-space indents under a numbered item still nest.
  assert.deepEqual(outline(markdownToBlocks('1. one\n  - two\n\t- three')), ['numbered_list_item: one', '  bulleted_list_item: two', '  bulleted_list_item: three']);
});

test('inline bold, italic, code, strikethrough and links become rich_text annotations', () => {
  const rich = richText('**b** *i* _u_ `c` ~~s~~ ***bi*** **b *bi* b** snake_case_word 2 * 3 * 4');
  const marks = rich.map((r) => [r.text.content, Object.keys(r.annotations ?? {}).join('+')]);
  assert.deepEqual(marks, [
    ['b', 'bold'], [' ', ''], ['i', 'italic'], [' ', ''], ['u', 'italic'], [' ', ''], ['c', 'code'], [' ', ''], ['s', 'strikethrough'], [' ', ''],
    ['bi', 'bold+italic'], [' ', ''], ['b ', 'bold'], ['bi', 'bold+italic'], [' b', 'bold'], [' snake_case_word 2 * 3 * 4', ''],
  ]);
  assert.deepEqual(richText('`a ** b` \\*not\\*').map((r) => r.text.content), ['a ** b', ' *not*']);
});

test('links: http(s) are kept, anything else is plain text', () => {
  const md = '[site](https://example.com/a?b=1) [rel](./guide.md) [mail](mailto:a@b.c) [js](javascript:alert(1)) <https://auto.example> https://bare.example/path). [ref] [**bold link**](http://x.example) [long](https://x.example/' + 'a'.repeat(2000) + ')\n\n[ref]: https://ref.example "Ref"';
  const rich = markdownToBlocks(md)[0].paragraph.rich_text;
  const links = rich.filter((r) => r.text.link).map((r) => [r.text.content, r.text.link.url, r.annotations?.bold ?? false]);
  assert.deepEqual(links, [
    ['site', 'https://example.com/a?b=1', false],
    ['https://auto.example', 'https://auto.example', false],
    ['https://bare.example/path', 'https://bare.example/path', false],
    ['ref', 'https://ref.example', false],
    ['bold link', 'http://x.example', true],
  ]);
  const text = plain(rich);
  for (const word of ['rel', 'mail', 'js', 'long']) assert.match(text, new RegExp(`\\b${word}\\b`));
  assert.ok(!text.includes('[ref]:'), 'reference definitions are not printed');
  assert.equal(markdownToBlocks(md).length, 1);
});

test('rich_text items hold at most 2000 characters and never split an emoji', () => {
  assert.deepEqual(splitText('abc', 2), ['ab', 'c']);
  assert.deepEqual(splitText(''), []);
  const text = `${'a'.repeat(1999)}😀${'b'.repeat(3000)}🎉`;
  const parts = splitText(text);
  assert.deepEqual(parts.map((p) => p.length), [1999, 2000, 1004]);
  assert.equal(parts[1].slice(0, 2), '😀');
  assert.equal(parts.join(''), text);
  for (const p of parts) assert.ok(!LONE_SURROGATE.test(p));
  // In a block: formatting survives the split, and a very long paragraph continues in more blocks of ≤100 items.
  const [para] = markdownToBlocks(`**${text}**`);
  assert.deepEqual(para.paragraph.rich_text.map((r) => [r.text.content.length, r.annotations.bold]), [[1999, true], [2000, true], [1004, true]]);
  const huge = markdownToBlocks('x'.repeat(450_000));
  assert.ok(huge.length > 1);
  for (const b of huge) assert.ok(b.paragraph.rich_text.length <= 100 && b.paragraph.rich_text.every((r) => r.text.content.length <= 2000));
  assert.equal(huge.map((b) => plain(b.paragraph.rich_text)).join(''), 'x'.repeat(450_000));
});

test('fenced and indented code keep their text; languages map to Notion’s list, else plain text', () => {
  const cases = { ts: 'typescript', TSX: 'typescript', js: 'javascript', python: 'python', py: 'python', sh: 'shell', bash: 'bash', zsh: 'shell', 'c++': 'c++', cpp: 'c++', cs: 'c#', yml: 'yaml', dockerfile: 'docker', rs: 'rust', golang: 'go', '{.rust}': 'rust', 'js title="app.js"': 'javascript', 'diff': 'diff', text: 'plain text', toml: 'plain text', cobol: 'plain text', '': 'plain text', undefined: 'plain text' };
  for (const [info, language] of Object.entries(cases)) assert.equal(notionLanguage(info === 'undefined' ? undefined : info), language, info);
  const blocks = markdownToBlocks('```ts\nconst a = 1;\n\nconst b = **2**;\n```\n\n~~~~ruby\nputs 1\n```\n~~~~\n\n```\n```\n\n    indented\n      more\n');
  assert.deepEqual(blocks.map((b) => [b.code.language, plain(b.code.rich_text)]), [
    ['typescript', 'const a = 1;\n\nconst b = **2**;'],
    ['ruby', 'puts 1\n```'],
    ['plain text', ''],
    ['plain text', 'indented\n  more'],
  ]);
  assert.ok(blocks.every((b) => !b.code.rich_text.some((r) => r.annotations)));
});

test('simple tables become table blocks with a header row', () => {
  const [table, after] = markdownToBlocks('| Name | Notes |\n|:-----|------:|\n| **a** | `x \\| y` |\n| b |\n| c | d | extra |\nAfter');
  assert.equal(table.type, 'table');
  assert.equal(table.table.table_width, 2);
  assert.equal(table.table.has_column_header, true);
  const rows = table.table.children.map((r) => r.table_row.cells.map(plain));
  assert.deepEqual(rows, [['Name', 'Notes'], ['a', 'x | y'], ['b', ''], ['c', 'd']]);
  assert.equal(table.table.children[1].table_row.cells[0][0].annotations.bold, true);
  assert.equal(after.type, 'paragraph');
  assert.deepEqual(markdownToBlocks('a | b\n--|--\n1 | 2')[0].table.children.length, 2);
  assert.equal(markdownToBlocks('not | a table\njust text')[0].type, 'paragraph');
});

test('images: an external image of a type Notion shows becomes an image block; others become links or text', () => {
  const blocks = markdownToBlocks('![Logo](https://example.com/logo.png?v=2)\n\n![Badge](https://img.shields.io/badge/x)\n\n![Local](./a.png)\n\n[![Linked](https://example.com/b.svg)](https://example.com)\n\nSee ![icon](https://example.com/i.gif) inline.');
  assert.deepEqual(blocks[0], { type: 'image', image: { type: 'external', external: { url: 'https://example.com/logo.png?v=2' }, caption: [{ type: 'text', text: { content: 'Logo' } }] } });
  assert.deepEqual(blocks[1].paragraph.rich_text, [{ type: 'text', text: { content: 'Badge', link: { url: 'https://img.shields.io/badge/x' } } }]);
  assert.deepEqual(blocks[2].paragraph.rich_text, [{ type: 'text', text: { content: 'Local' } }]);
  assert.equal(blocks[3].image.external.url, 'https://example.com/b.svg');
  assert.deepEqual(blocks[4].paragraph.rich_text.map((r) => [r.text.content, r.text.link?.url ?? null]), [['See ', null], ['icon', 'https://example.com/i.gif'], [' inline.', null]]);
});

test('the converter has no dependencies and no Node-only APIs', async () => {
  const source = await readFile(new URL('../src/notion.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s|\bimport\(|\brequire\(|\bBuffer\b|\bprocess\.|['"]node:/m);
});

test('page IDs come from an ID or a Notion URL; a page gets a title and ends with its source', () => {
  for (const input of [PARENT, PARENT_ID, PARENT.toUpperCase(), `https://www.notion.so/team/Research-${PARENT}?pvs=4`, `https://app.notion.com/p/${PARENT}`, `https://www.notion.so/team/${'f'.repeat(32)}?v=${'e'.repeat(32)}&p=${PARENT}`]) {
    assert.equal(notionPageId(input), PARENT_ID, input);
  }
  for (const bad of ['', 'nope', '1234', 'https://example.com/x', `${PARENT}0`]) assert.equal(notionPageId(bad), null, bad);
  const page = markdownToPage('# Docs\n\nHello', { source: 'https://example.com/' });
  assert.equal(page.title, 'Docs');
  assert.deepEqual(outline(page.blocks), ['paragraph: Hello', 'paragraph: Source: https://example.com/']);
  assert.deepEqual(page.blocks.at(-1).paragraph.rich_text[1].text.link, { url: 'https://example.com/' });
  const titled = markdownToPage('# Docs\n\nHello', { title: 'Mine', source: 'example.com' });
  assert.deepEqual(outline(titled.blocks), ['heading_1: Docs', 'paragraph: Hello', 'paragraph: Source: example.com']);
  assert.equal(titled.blocks.at(-1).paragraph.rich_text[1].text.link, undefined);
});

// ——— A stand-in for the Notion API: it checks every request against Notion's limits and keeps the page tree ———

function limitProblems(children, depth = 1) {
  const problems = [];
  if (children.length > 100) problems.push(`${children.length} children in one array`);
  if (depth > 2) problems.push('more than two levels of nesting');
  for (const b of children) {
    const v = b[b.type];
    if (b.type === 'table' && !v.children?.length) problems.push('a table without rows');
    for (const rich of [v.rich_text, v.caption, ...(v.cells ?? [])].filter(Boolean)) {
      if (rich.length > 100) problems.push(`${rich.length} rich_text items`);
      for (const r of rich) {
        if (r.text.content.length > 2000) problems.push(`a ${r.text.content.length}-character rich_text item`);
        if (LONE_SURROGATE.test(r.text.content)) problems.push('a split surrogate pair');
      }
    }
    if (v.children) problems.push(...limitProblems(v.children, depth + 1));
  }
  return problems;
}

const countAll = (blocks) => blocks.reduce((n, b) => n + 1 + countAll(kids(b)), 0);

async function startNotion({ token = TOKEN, inject = () => null } = {}) {
  const requests = [];
  const nodes = new Map();
  let serial = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
  const add = (parentId, children) => children.map((b) => {
    const id = newId();
    const { children: inner = [], ...data } = b[b.type];
    nodes.set(id, { block: { ...b, [b.type]: data }, children: [] });
    nodes.get(parentId).children.push(id);
    add(id, inner);
    return { object: 'block', id, type: b.type };
  });
  const tree = (id) => nodes.get(id).children.map((child) => {
    const { block } = nodes.get(child);
    const inner = tree(child);
    return inner.length ? { ...block, [block.type]: { ...block[block.type], children: inner } } : block;
  });
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const path = req.url;
    requests.push({ method: req.method, path, body, version: req.headers['notion-version'], authorization: req.headers.authorization });
    const send = (status, value, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };
    const error = (status, code, message) => send(status, { object: 'error', status, code, message });
    const injected = inject(requests.length, req.method, path);
    if (injected) return send(injected.status, injected.body, injected.headers);
    if (req.headers.authorization !== `Bearer ${token}`) return error(401, 'unauthorized', 'API token is invalid.');
    if (req.headers['notion-version'] !== NOTION_VERSION) return error(400, 'missing_version', 'Notion-Version header failed validation.');
    const children = body?.children ?? [];
    const problems = [...limitProblems(children), ...(countAll(children) > 1000 ? ['more than 1000 block elements'] : []), ...(Buffer.byteLength(text) > 500_000 ? ['more than 500 KB'] : [])];
    if (problems.length) return error(400, 'validation_error', problems.join('; '));
    if (req.method === 'POST' && path === '/v1/pages') {
      const parent = body.parent.page_id;
      if (parent !== PARENT_ID) return error(404, 'object_not_found', `Could not find page with ID: ${parent}.`);
      const id = newId();
      nodes.set(id, { title: plain(body.properties.title.title), children: [] });
      add(id, children);
      return send(200, { object: 'page', id, url: `https://app.notion.com/p/${id.replace(/-/g, '')}` });
    }
    const m = /^\/v1\/blocks\/([^/]+)\/children$/.exec(path);
    if (req.method === 'PATCH' && m && nodes.has(m[1])) return send(200, { object: 'list', results: add(m[1], children), next_cursor: null, has_more: false });
    return error(404, 'object_not_found', 'Could not find block.');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    requests,
    page: () => {
      const id = requests.length && [...nodes.keys()].find((k) => nodes.get(k).title !== undefined);
      return id && { id, title: nodes.get(id).title, blocks: tree(id) };
    },
    /** fetch that sends api.notion.com requests to the stand-in. */
    fetch: (url, init) => fetch(String(url).replace(NOTION_API, base), init),
    close: () => new Promise((done) => server.close(done)),
  };
}

const rateLimited = (seconds) => ({
  status: 429,
  headers: seconds === undefined ? {} : { 'retry-after': String(seconds) },
  body: { object: 'error', status: 429, code: 'rate_limited', message: 'You have been rate limited.', additional_data: { rate_limit_reason: 'public_api_request_rate_limit' } },
});

function bigDocument() {
  const paragraphs = Array.from({ length: 250 }, (_, i) => `Paragraph ${i} with **bold** text.`).join('\n\n');
  const deep = '- level 1\n  - level 2\n    - level 3\n      - level 4\n        - level 5\n      - level 4b\n  - level 2b';
  const table = `| n | square |\n|---|---|\n${Array.from({ length: 150 }, (_, i) => `| ${i} | ${i * i} |`).join('\n')}`;
  const wide = `- parent\n${Array.from({ length: 120 }, (_, i) => `  - child ${i}`).join('\n')}`;
  const long = `> ${'🙂'.repeat(1500)}`;
  return [paragraphs, deep, table, wide, long, 'The end.'].join('\n\n');
}

test('saveToNotion creates the page, appends in batches of ≤100, follows up deep nesting, and keeps every block', async () => {
  const notion = await startNotion();
  try {
    const { title, blocks } = markdownToPage(bigDocument(), { title: 'Big', source: 'https://example.com/docs' });
    const progress = [];
    const page = await saveToNotion({ token: TOKEN, parent: `https://www.notion.so/Research-${PARENT}`, title, blocks, base: notion.base, onProgress: (p) => progress.push(p) });
    const stored = notion.page();
    assert.equal(stored.title, 'Big');
    assert.deepEqual(stored.blocks, blocks);
    assert.equal(page.url, `https://app.notion.com/p/${stored.id.replace(/-/g, '')}`);
    assert.equal(page.blocks, countAll(blocks));
    assert.equal(page.requests, notion.requests.length);
    const [create, ...appends] = notion.requests;
    assert.equal(create.method, 'POST');
    assert.equal(create.path, '/v1/pages');
    assert.equal(create.body.parent.page_id, PARENT_ID);
    assert.equal(create.body.children.length, 100);
    assert.ok(notion.requests.every((r) => r.version === NOTION_VERSION && r.authorization === `Bearer ${TOKEN}`));
    assert.ok(appends.every((r) => r.method === 'PATCH' && r.body.children.length <= 100));
    // The rest of the top level in two batches, then follow-ups: the deep list one level at a time, 50 more table rows, 20 more children.
    const toPage = appends.filter((r) => r.path === `/v1/blocks/${stored.id}/children`);
    assert.deepEqual(toPage.map((r) => r.body.children.length), [100, 56]);
    assert.ok(appends.some((r) => r.body.children.length === 51 && r.body.children.every((c) => c.type === 'table_row')));
    assert.ok(appends.some((r) => r.body.children.length === 20 && plain(r.body.children[0].bulleted_list_item.rich_text) === 'child 100'));
    // "level 1" goes alone (its child has children); each level follows once its parent exists, with leaf children inline.
    const shapes = appends.map((r) => outline(r.body.children).join(' | '));
    assert.ok(shapes.includes('bulleted_list_item: level 2 | bulleted_list_item: level 2b'));
    assert.ok(shapes.includes('bulleted_list_item: level 3'));
    assert.ok(shapes.includes('bulleted_list_item: level 4 |   bulleted_list_item: level 5 | bulleted_list_item: level 4b'));
    assert.deepEqual(progress.at(-1), { done: page.blocks, total: page.blocks });
  } finally {
    await notion.close();
  }
});

test('a 429 waits for Retry-After (else backs off) and retries; a blocked connection or too many 429s fail', async () => {
  // Requests: create (429 with Retry-After: 3, then OK), append to the page (429 without it: 1 s, then OK), append to "a" (529 with 0, then OK), append to "b".
  const notion = await startNotion({ inject: (n) => (n === 1 ? rateLimited(3) : n === 3 ? rateLimited() : n === 5 ? { ...rateLimited(0), status: 529, body: { object: 'error', status: 529, code: 'service_overload', message: 'Overloaded.' } } : null) });
  try {
    const waits = [];
    const told = [];
    const { title, blocks } = markdownToPage('# T\n\n- a\n  - b\n    - c', { source: 'https://example.com/' });
    const page = await saveToNotion({ token: TOKEN, parent: PARENT, title, blocks, base: notion.base, sleep: async (ms) => waits.push(ms), onWait: (s) => told.push(s) });
    assert.deepEqual(waits, [3000, 1000, 0]);
    assert.deepEqual(told, [3, 1, 0]);
    assert.deepEqual(notion.page().blocks, blocks);
    assert.equal(page.requests, notion.requests.length);
  } finally {
    await notion.close();
  }
  const blocked = await startNotion({ inject: () => ({ ...rateLimited(1), body: { ...rateLimited(1).body, additional_data: { rate_limit_reason: 'public_api_request_blocked' } } }) });
  try {
    const waits = [];
    await assert.rejects(saveToNotion({ token: TOKEN, parent: PARENT, title: 'x', blocks: [], base: blocked.base, sleep: async (ms) => waits.push(ms) }), (err) => err instanceof NotionError && err.status === 429 && /rate limiting/.test(err.message));
    assert.deepEqual(waits, []);
    assert.equal(blocked.requests.length, 1);
  } finally {
    await blocked.close();
  }
  const busy = await startNotion({ inject: () => rateLimited(0) });
  try {
    await assert.rejects(saveToNotion({ token: TOKEN, parent: PARENT, title: 'x', blocks: [], base: busy.base, retries: 2 }), /rate limiting/);
    assert.equal(busy.requests.length, 3);
  } finally {
    await busy.close();
  }
});

test('Notion’s refusals are explained: bad token, unknown parent, and a page left incomplete', async () => {
  const notion = await startNotion({ inject: (n, method) => (n > 1 && method === 'PATCH' ? { status: 400, body: { object: 'error', status: 400, code: 'validation_error', message: 'body failed validation.' } } : null) });
  try {
    await assert.rejects(saveToNotion({ token: 'wrong', parent: PARENT, title: 'x', blocks: [], base: notion.base }), (err) => err.status === 401 && err.message === 'Notion didn’t accept the token (401 unauthorized).' && !err.message.includes('wrong'));
    await assert.rejects(saveToNotion({ token: TOKEN, parent: 'f'.repeat(32), title: 'x', blocks: [], base: notion.base }), (err) => err.status === 404 && /can’t find the parent page.*Connections/.test(err.message));
    await assert.rejects(saveToNotion({ token: TOKEN, parent: 'nope', title: 'x', blocks: [], base: notion.base }), /parent must be a Notion page ID or URL/);
    const { blocks } = markdownToPage('- a\n  - b\n    - c');
    await assert.rejects(saveToNotion({ token: TOKEN, parent: PARENT, title: 'x', blocks, base: notion.base }), (err) => err.status === 400 && /^Notion answered 400 validation_error: body failed validation\. The page was created but is incomplete: https:\/\/app\.notion\.com\/p\//.test(err.message));
  } finally {
    await notion.close();
  }
  await assert.rejects(saveToNotion({ token: TOKEN, parent: PARENT, title: 'x', blocks: [], base: 'http://127.0.0.1:9' }), (err) => err.status === 0 && /Couldn’t reach 127\.0\.0\.1:9/.test(err.message));
});

// ——— The CLI ———

function capture() {
  let text = '';
  const stream = new Writable({ write(chunk, _enc, done) { text += chunk; done(); } });
  Object.defineProperty(stream, 'text', { get: () => text });
  return stream;
}

async function cli(argv, { env = {}, notion, llms }) {
  const stdout = capture();
  const stderr = capture();
  const code = await main({ argv, env: { LLMS_INK_API: llms.api, ...env }, stdout, stderr, fetch: notion?.fetch ?? fetch });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

test('llms-ink notion reads the link through llms.ink and saves it under --parent, printing the page URL', async () => {
  const llms = await startMock();
  const notion = await startNotion();
  try {
    const result = await cli(['notion', 'llmstxt.org', '--full', '--parent', `https://www.notion.so/team/Research-${PARENT}?pvs=4`], { env: { NOTION_TOKEN: TOKEN }, notion, llms });
    assert.equal(result.code, 0, result.stderr);
    const stored = notion.page();
    assert.equal(result.stdout, `https://app.notion.com/p/${stored.id.replace(/-/g, '')}\n`);
    assert.match(result.stderr, /Saved “llms\.txt” to Notion · 7 blocks · 1 request\n/);
    assert.ok(!result.stderr.includes(TOKEN) && !result.stdout.includes(TOKEN));
    assert.deepEqual(llms.requests, [{ path: '/api/v0/llms', query: { url: 'llmstxt.org', mode: 'full' } }]);
    assert.equal(stored.title, 'llms.txt');
    assert.deepEqual(outline(stored.blocks), [
      'quote: A proposal for LLM-friendly content.', 'heading_2: Docs', 'bulleted_list_item: Proposal: The proposal',
      'divider: ', 'heading_1: Proposal', 'paragraph: The full text.', 'paragraph: Source: https://llmstxt.org/',
    ]);
    assert.deepEqual(stored.blocks, markdownToPage(FULL, { title: 'llms.txt', source: 'https://llmstxt.org/' }).blocks);
    assert.equal(stored.blocks[2].bulleted_list_item.rich_text[0].text.link.url, 'https://llmstxt.org/index.md');

    // --title names the page; --token wins over NOTION_TOKEN.
    const titled = await cli(['notion', 'llmstxt.org', '--parent', PARENT, '--title', 'My notes', '--token', TOKEN, '--quiet'], { env: { NOTION_TOKEN: 'stale' }, notion, llms });
    assert.equal(titled.code, 0, titled.stderr);
    assert.equal(titled.stderr, '');
    assert.equal(notion.requests.at(-1).body.properties.title.title[0].text.content, 'My notes');
    assert.equal(notion.requests.at(-1).authorization, `Bearer ${TOKEN}`);
  } finally {
    await notion.close();
    await llms.close();
  }
});

test('llms-ink notion explains Notion and llms.ink refusals without printing the token', async () => {
  const llms = await startMock();
  const notion = await startNotion();
  try {
    const bad = await cli(['notion', 'llmstxt.org', '--parent', PARENT], { env: { NOTION_TOKEN: 'ntn_wrong_token' }, notion, llms });
    assert.equal(bad.code, 1);
    assert.equal(bad.stderr.trim().split('\n').at(-1), 'llms-ink: Notion didn’t accept the token (401 unauthorized). Check NOTION_TOKEN or --token.');
    assert.ok(!bad.stderr.includes('ntn_wrong_token') && !bad.stdout.includes('ntn_wrong_token'));
    notion.requests.length = 0;
    const refused = await cli(['notion', 'example.com/private', '--parent', PARENT], { env: { NOTION_TOKEN: TOKEN }, notion, llms });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /llms-ink: That page needs a login/);
    assert.equal(notion.requests.length, 0);
  } finally {
    await notion.close();
    await llms.close();
  }
});

test('llms-ink notion: wrong usage exits 2 with a reason and makes no request', async () => {
  const llms = await startMock();
  const notion = await startNotion();
  try {
    const env = { NOTION_TOKEN: TOKEN };
    for (const [argv, why, environment = env] of [
      [['notion'], /Give a link: llms-ink notion <link> --parent <page-id-or-url>/],
      [['notion', 'llmstxt.org'], /Give the parent page: llms-ink notion <link> --parent/],
      [['notion', 'llmstxt.org', '--parent', 'my-page'], /--parent: a Notion page ID or URL/],
      [['notion', 'llmstxt.org', '--parent', 'https://example.com/page'], /--parent: a Notion page ID or URL/],
      [['notion', 'llmstxt.org', '--parent', PARENT], /Set NOTION_TOKEN to your Notion connection’s token \(or pass --token\)/, {}],
      [['notion', 'llmstxt.org', '--parent', PARENT, '--token', '  '], /Set NOTION_TOKEN/, {}],
      [['notion', 'a.com', 'b.com', '--parent', PARENT], /One link at a time/],
      [['notion', 'llmstxt.org', '--parent', PARENT, '-o', 'x.txt'], /notion saves to Notion and prints the page URL; -o isn’t used/],
      [['notion', 'llmstxt.org', '--parent', PARENT, '--json'], /--json is for llms\.txt, check, parse, report and generate, not notion/],
      [['notion', 'llmstxt.org', '--parent', PARENT, '-t', '5'], /--time and --width are for frame/],
      [['llmstxt.org', '--parent', PARENT], /--parent, --title and --token are for notion/],
      [['check', 'llmstxt.org', '--title', 'x'], /--parent, --title and --token are for notion/],
      [['llmstxt.org', '--token', TOKEN], /--parent, --title and --token are for notion/],
      [['notion', 'llmstxt.org', '--parent'], /--parent/],
    ]) {
      const result = await cli(argv, { env: environment, notion, llms });
      assert.equal(result.code, 2, argv.join(' '));
      assert.match(result.stderr, why, argv.join(' '));
      assert.ok(!result.stderr.includes(TOKEN), argv.join(' '));
    }
    assert.equal(llms.requests.length, 0);
    assert.equal(notion.requests.length, 0);
    const help = await cli(['--help'], { notion, llms });
    assert.match(help.stdout, /llms-ink notion <link> --parent <page>/);
    assert.match(help.stdout, /--token <t> +notion: Notion connection token \(or NOTION_TOKEN\); never printed/);
  } finally {
    await notion.close();
    await llms.close();
  }
});

test('block-level HTML comments are dropped; code and unclosed openers keep them', () => {
  assert.deepEqual(outline(markdownToBlocks('text\n\n<!--\nhidden\n-->\n\n<!-- Generated with https://llms.ink -->')), ['paragraph: text']);
  assert.deepEqual(outline(markdownToBlocks('```\n<!-- kept -->\n```')), ['code: <!-- kept -->']);
  assert.deepEqual(outline(markdownToBlocks('<!-- open\nstill text')), ['paragraph: <!-- open still text']);
});
