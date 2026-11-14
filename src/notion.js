// Markdown → Notion blocks, and saving them as a Notion page through the public REST API.
// No dependencies and no Node-only APIs (only fetch, URL and timers), so any llms.ink surface can reuse it.

/** The Notion API version this module speaks (developers.notion.com/reference/versioning). */
export const NOTION_VERSION = '2026-03-11';
export const NOTION_API = 'https://api.notion.com';

// Notion's documented request limits (developers.notion.com/reference/request-limits).
const MAX_TEXT = 2000; // characters per rich_text item; counted in UTF-16 code units, never fewer than Notion counts
const MAX_ITEMS = 100; // elements per array: blocks in a request, children of a block, rich_text items, table cells
const MAX_URL = 2000;
const MAX_ELEMENTS = 1000; // block elements per request
const MAX_BYTES = 450_000; // request payloads are capped at 500 KB; this leaves room for the envelope
const MAX_NESTING = 32; // lists, quotes and inline spans nested deeper than this stay as text (keeps recursion bounded)
const BLOCK_TEXT = 100_000; // UTF-16 units of text per block, so one block stays well under MAX_BYTES

/** Notion's code block languages. */
const LANGUAGES = new Set(['abap', 'arduino', 'bash', 'basic', 'c', 'clojure', 'coffeescript', 'c++', 'c#', 'css', 'dart', 'diff', 'docker', 'elixir', 'elm', 'erlang', 'flow', 'fortran', 'f#', 'gherkin', 'glsl', 'go', 'graphql', 'groovy', 'haskell', 'html', 'java', 'javascript', 'json', 'julia', 'kotlin', 'latex', 'less', 'lisp', 'livescript', 'lua', 'makefile', 'markdown', 'markup', 'matlab', 'mermaid', 'nix', 'objective-c', 'ocaml', 'pascal', 'perl', 'php', 'plain text', 'powershell', 'prolog', 'protobuf', 'python', 'r', 'reason', 'ruby', 'rust', 'sass', 'scala', 'scheme', 'scss', 'shell', 'sql', 'swift', 'typescript', 'vb.net', 'verilog', 'vhdl', 'visual basic', 'webassembly', 'xml', 'yaml', 'java/c/c++/c#']);
/** Common fence names for those languages. */
const ALIASES = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', py3: 'python', python3: 'python', pyi: 'python', ipython: 'python',
  sh: 'shell', zsh: 'shell', fish: 'shell', ksh: 'shell', console: 'shell', 'shell-session': 'shell', shellsession: 'shell', terminal: 'shell',
  ps: 'powershell', ps1: 'powershell', pwsh: 'powershell',
  rb: 'ruby', rs: 'rust', golang: 'go', kt: 'kotlin', kts: 'kotlin', cs: 'c#', csharp: 'c#',
  cpp: 'c++', cxx: 'c++', cc: 'c++', hpp: 'c++', h: 'c', objc: 'objective-c', objectivec: 'objective-c', fs: 'f#', fsharp: 'f#',
  yml: 'yaml', md: 'markdown', mdx: 'markdown', htm: 'html', xhtml: 'html', vue: 'html', svelte: 'html', svg: 'xml', plist: 'xml',
  jsonc: 'json', json5: 'json', jsonl: 'json', dockerfile: 'docker', containerfile: 'docker', make: 'makefile', mk: 'makefile',
  tex: 'latex', hs: 'haskell', ex: 'elixir', exs: 'elixir', erl: 'erlang', clj: 'clojure', cljs: 'clojure', edn: 'clojure',
  coffee: 'coffeescript', gql: 'graphql', proto: 'protobuf', vb: 'visual basic', vbnet: 'vb.net', wasm: 'webassembly', wat: 'webassembly',
  patch: 'diff', ml: 'ocaml', pl: 'perl', sv: 'verilog', systemverilog: 'verilog', ino: 'arduino', gradle: 'groovy', el: 'lisp', elisp: 'lisp',
  postgres: 'sql', postgresql: 'sql', psql: 'sql', mysql: 'sql', sqlite: 'sql', plsql: 'sql', tsql: 'sql',
  text: 'plain text', txt: 'plain text', plaintext: 'plain text', plain: 'plain text',
};
/** Image types Notion shows from an external URL; other images become links, so a page never fails on one. */
const IMAGE_TYPES = /\.(?:bmp|gif|heic|jpe?g|png|svg|tiff?)$/i;

/** A fence's info string (`ts`, `python title="x"`, `{.rust}`) → one of Notion's languages; `plain text` when unknown. */
export function notionLanguage(info) {
  const name = String(info ?? '').trim().toLowerCase().replace(/^\{?\.?/, '').split(/[\s,{}:]/)[0];
  if (LANGUAGES.has(name)) return name;
  return Object.hasOwn(ALIASES, name) ? ALIASES[name] : 'plain text';
}

/** Splits text into pieces of at most `max` UTF-16 units, never between the two halves of a surrogate pair (emoji). */
export function splitText(text, max = MAX_TEXT) {
  const parts = [];
  let i = 0;
  while (text.length - i > max) {
    let end = i + max;
    const c = text.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end--;
    parts.push(text.slice(i, end));
    i = end;
  }
  if (i < text.length) parts.push(text.slice(i));
  return parts;
}

/** A Notion page ID from an ID (with or without dashes) or a page URL; null when there's none. */
export function notionPageId(input) {
  const text = String(input ?? '').trim();
  const bare = (s) => /^[0-9a-f]{32}$/i.exec(s.replace(/-/g, ''))?.[0];
  let hex = /^[0-9a-f-]{32,36}$/i.test(text) ? bare(text) : undefined;
  if (!hex && /^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      // A page opened as a side peek (`?p=<id>`) is the page you're looking at.
      hex = bare(url.searchParams.get('p') ?? '') ?? url.pathname.match(/[0-9a-f]{32}(?=[^0-9a-f]*$)/i)?.[0];
    } catch {}
  }
  if (!hex) return null;
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const linkable = (url) => (typeof url === 'string' && url.length <= MAX_URL && /^https?:\/\/[^\s]+$/i.test(url) ? url : null);

function textItem(content, marks) {
  const item = { type: 'text', text: { content, ...(marks.link && { link: { url: marks.link } }) } };
  const annotations = {};
  for (const name of ['bold', 'italic', 'strikethrough', 'code']) if (marks[name]) annotations[name] = true;
  if (Object.keys(annotations).length) item.annotations = annotations;
  return item;
}

/** Plain text as rich_text items of at most 2000 characters. */
export function plainRichText(text, link = null) {
  return splitText(String(text)).map((t) => textItem(t, { link: linkable(link) }));
}

// ——— Inline Markdown: bold, italic, code, strikethrough and links as rich_text annotations ———

const PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const AUTOLINK = /<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*)>/iy;
const BR = /<br\s*\/?>/iy;
const BARE_URL = /https?:\/\/[^\s<>]+/iy;

const runLength = (s, i, c) => {
  let j = i;
  while (s[j] === c) j++;
  return j - i;
};

/** Lookups over one string that keep inline parsing linear: bracket pairs, and where searches already came up empty. */
function scanner(s) {
  const pairs = new Map();
  const open = [];
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '[') open.push(j);
    else if (s[j] === ']' && open.length) pairs.set(open.pop(), j);
  }
  return { s, pairs, noTicks: new Map(), noCloser: new Map() };
}

/** Where a code span opened by `n` backticks closes (a run of exactly n), or -1. */
function codeClose(sc, from, n) {
  const { s, noTicks } = sc;
  if (from >= (noTicks.get(n) ?? Infinity)) return -1;
  for (let j = s.indexOf('`', from); j >= 0; j = s.indexOf('`', j)) {
    const r = runLength(s, j, '`');
    if (r === n) return j;
    j += r;
  }
  noTicks.set(n, from);
  return -1;
}

const normalizeRef = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();

/** `[label](url "title")`, `[label][ref]`, `[label][]` or `[ref]` starting at `s[i] === '['`; null when it isn't a link. */
function parseLink(sc, i, refs) {
  const { s } = sc;
  const close = sc.pairs.get(i);
  if (close === undefined) return null;
  const label = s.slice(i + 1, close);
  if (s[close + 1] === '(') {
    const dest = destination(s, close + 2);
    if (dest) return { label, url: dest.url, end: dest.end };
  }
  if (s[close + 1] === '[') {
    const end = s.indexOf(']', close + 2);
    const ref = end >= 0 && normalizeRef(s.slice(close + 2, end) || label);
    if (ref && refs.has(ref)) return { label, url: refs.get(ref), end: end + 1 };
  }
  const ref = normalizeRef(label);
  return refs.has(ref) ? { label, url: refs.get(ref), end: close + 1 } : null;
}

/**
 * A link destination and optional title after `(`, through the closing `)`. Looks at most 4096 characters ahead, so
 * text full of `[x](` stays linear; a longer destination couldn't be a Notion link anyway (2000 at most).
 */
function destination(s, j) {
  const stop = Math.min(s.length, j + 4096);
  const find = (ch, from) => {
    const at = s.indexOf(ch, from);
    return at >= 0 && at < stop ? at : -1;
  };
  while (SPACE.test(s[j] ?? '')) j++;
  let url = '';
  if (s[j] === '<') {
    const end = find('>', j);
    if (end < 0 || s.slice(j, end).includes('\n')) return null;
    url = s.slice(j + 1, end);
    j = end + 1;
  } else {
    let depth = 0;
    for (; j < stop && !SPACE.test(s[j]); j++) {
      if (s[j] === '\\' && PUNCT.test(s[j + 1] ?? '')) url += s[++j];
      else if (s[j] === '(') {
        depth++;
        url += '(';
      } else if (s[j] === ')') {
        if (depth === 0) break;
        depth--;
        url += ')';
      } else url += s[j];
    }
    if (j >= stop) return null;
  }
  while (SPACE.test(s[j] ?? '')) j++;
  const quote = { '"': '"', "'": "'", '(': ')' }[s[j]];
  if (quote) {
    const end = find(quote, j + 1);
    if (end < 0) return null;
    j = end + 1;
    while (SPACE.test(s[j] ?? '')) j++;
  }
  return s[j] === ')' ? { url, end: j + 1 } : null;
}

/** An emphasis or strikethrough span opened at `s[i]`: its content range and marks; null when nothing closes it. */
function emphasis(sc, i) {
  const { s } = sc;
  const c = s[i];
  const run = runLength(s, i, c);
  const after = s[i + run] ?? '';
  if (!after || SPACE.test(after)) return null;
  if (c === '_' && WORD.test(s[i - 1] ?? '')) return null;
  if (c === '~' && run > 2) return null;
  const size = c === '~' ? run : Math.min(run, 3);
  // Every later opener of the same kind sees a subset of these closers: once none fits, skip the search.
  const key = c + size;
  if (i + run >= (sc.noCloser.get(key) ?? Infinity)) return null;
  for (let j = i + run; j < s.length; j++) {
    const ch = s[j];
    if (ch === '\\') {
      j++;
      continue;
    }
    if (ch === '`') {
      const r = runLength(s, j, '`');
      const end = codeClose(sc, j + r, r);
      j = (end >= 0 ? end : j) + r - 1;
      continue;
    }
    if (ch !== c) continue;
    const r = runLength(s, j, c);
    const ok = !SPACE.test(s[j - 1]) && !(c === '_' && WORD.test(s[j + r] ?? ''));
    // Which part of the closing run closes this span: `**a *b***` closes the bold with the last two.
    const fits = c === '~' ? r === size : size === 3 ? r >= 3 : size === 2 ? r >= 2 : r === 1 || r >= 3;
    if (ok && fits && j > i + run) {
      const at = c === '~' ? j : j + r - size;
      const marks = c === '~' ? { strikethrough: true } : { ...(size !== 1 && { bold: true }), ...(size !== 2 && { italic: true }) };
      return { start: i + size, end: at, next: at + size, marks };
    }
    j += r - 1;
  }
  sc.noCloser.set(key, i + run);
  return null;
}

function trimUrl(url) {
  for (;;) {
    if (/[.,:;!?'"*_~]$/.test(url)) url = url.slice(0, -1);
    else if (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
    else return url;
  }
}

const sameMarks = (a, b) => !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.strikethrough === !!b.strikethrough && !!a.code === !!b.code && (a.link ?? null) === (b.link ?? null);

function pushText(out, text, marks) {
  if (!text) return;
  const last = out.at(-1);
  if (last && sameMarks(last.marks, marks)) last.text += text;
  else out.push({ text, marks });
}

/** Inline Markdown → [{ text, marks }]. Images become their alt text, linked to the image. */
function inline(s, refs, marks = {}, out = [], depth = 0) {
  if (depth > MAX_NESTING) {
    pushText(out, s, marks);
    return out;
  }
  const sc = scanner(s);
  let buf = '';
  const flush = () => {
    pushText(out, buf, marks);
    buf = '';
  };
  const sticky = (re, at) => {
    re.lastIndex = at;
    return re.exec(s);
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === '\\' && PUNCT.test(s[i + 1] ?? '')) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const run = runLength(s, i, '`');
      const close = codeClose(sc, i + run, run);
      if (close >= 0) {
        flush();
        let code = s.slice(i + run, close).replace(/\n/g, ' ');
        if (/^ [^]*[^ ][^]* $/.test(code)) code = code.slice(1, -1);
        pushText(out, code, { ...marks, code: true });
        i = close + run;
      } else {
        buf += s.slice(i, i + run);
        i += run;
      }
      continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      const link = parseLink(sc, i + 1, refs);
      if (link) {
        flush();
        pushText(out, inline(link.label, refs, {}, [], depth + 1).map((x) => x.text).join('') || link.url, { ...marks, link: marks.link ?? linkable(link.url) });
        i = link.end;
        continue;
      }
    }
    if (c === '[') {
      const link = parseLink(sc, i, refs);
      if (link) {
        flush();
        inline(link.label, refs, { ...marks, link: marks.link ?? linkable(link.url) }, out, depth + 1);
        i = link.end;
        continue;
      }
    }
    if (c === '<') {
      const auto = sticky(AUTOLINK, i);
      if (auto) {
        flush();
        pushText(out, auto[1], { ...marks, link: marks.link ?? linkable(auto[1]) });
        i += auto[0].length;
        continue;
      }
      const br = sticky(BR, i);
      if (br) {
        buf += '\n';
        i += br[0].length;
        continue;
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      const em = emphasis(sc, i);
      if (em) {
        flush();
        inline(s.slice(em.start, em.end), refs, { ...marks, ...em.marks }, out, depth + 1);
        i = em.next;
      } else {
        const run = runLength(s, i, c);
        buf += s.slice(i, i + run);
        i += run;
      }
      continue;
    }
    if ((c === 'h' || c === 'H') && !marks.link && !WORD.test(s[i - 1] ?? '')) {
      const bare = sticky(BARE_URL, i);
      if (bare) {
        const url = trimUrl(bare[0]);
        flush();
        pushText(out, url, { ...marks, link: linkable(url) });
        i += url.length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/**
 * Inline Markdown → Notion rich_text items: **bold**, *italic*, `code`, ~~strikethrough~~ and links as annotations.
 * Each item holds at most 2000 characters. Links that aren't http(s) (relative, mailto:, …) stay as plain text.
 */
export function richText(markdown, refs = new Map()) {
  return inline(String(markdown), refs).flatMap((seg) => splitText(seg.text).map((t) => textItem(t, seg.marks)));
}

// ——— Block Markdown ———

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)/;
const NESTED_ITEM = /^ *(?:[-*+]|\d{1,9}[.)])(?: |$)/;
const TASK = /^\[([ xX])\](?:[ \t]+|$)/;
const DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const REF_DEF = /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
const IMAGE = /\[!\[([^\]]*)\]\(<?([^\s)>]*)>?(?:\s+"[^"]*")?\)\]\([^)]*\)|!\[([^\]]*)\]\(<?([^\s)>]*)>?(?:\s+"[^"]*")?\)/g;

const indentOf = (line) => line.length - line.trimStart().length;
const isFence = (line) => {
  const m = FENCE.exec(line);
  return !!m && !(m[2][0] === '`' && m[3].includes('`'));
};
const startsBlock = (line) => isFence(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line) || /^ {0,3}(?:[-*+]|1[.)])[ \t]+\S/.test(line);

function expandTabs(line) {
  return line.replace(/^[ \t]+/, (ws) => {
    let col = 0;
    for (const ch of ws) col = ch === '\t' ? col + 4 - (col % 4) : col + 1;
    return ' '.repeat(col);
  });
}

function tableCells(row) {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && s[k + 1] === '|') {
      cell += '|';
      k++;
    } else if (s[k] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else cell += s[k];
  }
  cells.push(cell.trim());
  return cells;
}

function isTableStart(lines, i) {
  const head = lines[i];
  const delimiter = lines[i + 1];
  if (!head?.includes('|') || delimiter === undefined || !DELIMITER.test(delimiter)) return false;
  if (!delimiter.includes('|') && !head.trim().startsWith('|')) return false;
  return tableCells(head).length === tableCells(delimiter).length;
}

/** Rich text as blocks of `type`: a block holds at most 100 items; the rest continue in blocks of `next`. */
function textBlocks(type, rich, data = {}, next = 'paragraph') {
  const blocks = [];
  let group = [];
  let size = 0;
  const close = () => {
    const kind = blocks.length ? next : type;
    blocks.push({ type: kind, [kind]: { rich_text: group, ...(kind === type && data) } });
    group = [];
    size = 0;
  };
  for (const item of rich) {
    if (group.length === MAX_ITEMS || size + item.text.content.length > BLOCK_TEXT) close();
    group.push(item);
    size += item.text.content.length;
  }
  if (group.length || (type === 'code' && !blocks.length)) close();
  return blocks;
}

function joinLines(lines) {
  return lines
    .map((line, k) => {
      const text = line.trimStart();
      if (k === lines.length - 1) return text.trimEnd();
      return / {2,}$|\\$/.test(text) ? `${text.replace(/ {2,}$|\\$/, '')}\n` : `${text.trimEnd()} `;
    })
    .join('');
}

function heading(level, text, refs) {
  const type = `heading_${Math.min(level, 3)}`;
  return textBlocks(type, richText(text.trim(), refs));
}

/** A paragraph; one made only of images becomes image blocks. */
function paragraph(lines, refs) {
  const text = joinLines(lines);
  const images = [...text.matchAll(IMAGE)];
  if (images.length && !text.replace(IMAGE, '').trim()) {
    return images.flatMap((m) => {
      const alt = m[1] ?? m[3];
      const src = m[2] ?? m[4];
      const url = linkable(src);
      if (url && IMAGE_TYPES.test(url.split(/[?#]/)[0])) {
        return [{ type: 'image', image: { type: 'external', external: { url }, ...(alt.trim() && { caption: richText(alt, refs) }) } }];
      }
      return textBlocks('paragraph', plainRichText(alt.trim() || src, url));
    });
  }
  return textBlocks('paragraph', richText(text, refs));
}

/** The text of a container's leading paragraph becomes its own rich_text; the other blocks become its children. */
function container(type, data, kids) {
  const own = kids[0]?.type === 'paragraph' ? kids.shift().paragraph.rich_text : [];
  return { type, [type]: { rich_text: own, ...data, ...(kids.length && { children: kids }) } };
}

function parseBlocks(lines, refs, depth = 0) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) {
      i++;
    } else if (isFence(line)) {
      m = FENCE.exec(line);
      const [, pad, fence, info] = m;
      const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
      const code = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) code.push(lines[i].replace(new RegExp(`^ {0,${pad.length}}`), ''));
      i++;
      out.push(...textBlocks('code', plainRichText(code.join('\n')), { language: notionLanguage(info) }, 'code'));
    } else if (indentOf(line) >= 4) {
      const code = [];
      for (; i < lines.length && (!lines[i].trim() || indentOf(lines[i]) >= 4); i++) code.push(lines[i].slice(4));
      while (code.length && !code.at(-1).trim()) code.pop();
      out.push(...textBlocks('code', plainRichText(code.join('\n')), { language: 'plain text' }, 'code'));
    } else if ((m = ATX.exec(line))) {
      out.push(...heading(m[1].length, m[2] ?? '', refs));
      i++;
    } else if (HR.test(line)) {
      out.push({ type: 'divider', divider: {} });
      i++;
    } else if (depth < MAX_NESTING && QUOTE.test(line)) {
      const inner = [];
      for (; i < lines.length; i++) {
        const q = QUOTE.exec(lines[i]);
        if (q) inner.push(q[1]);
        else if (lines[i].trim() && inner.at(-1)?.trim() && !startsBlock(lines[i])) inner.push(lines[i]); // lazy continuation
        else break;
      }
      out.push(container('quote', {}, parseBlocks(inner, refs, depth + 1)));
    } else if (depth < MAX_NESTING && (m = ITEM.exec(line))) {
      const indent = m[1].length;
      const marker = m[2];
      const offset = indent + marker.length + (m[3].length > 4 || !m[3] ? 1 : m[3].length);
      const content = [line.slice(Math.min(offset, line.length))];
      for (i++; i < lines.length; i++) {
        const l = lines[i];
        const ind = indentOf(l);
        if (!l.trim()) {
          let k = i;
          while (k < lines.length && !lines[k].trim()) k++;
          if (k === lines.length || indentOf(lines[k]) < offset) break;
          content.push(...lines.slice(i, k).map(() => ''));
          i = k - 1;
        } else if (ind >= offset || (ind >= indent + 2 && NESTED_ITEM.test(l))) {
          content.push(l.slice(Math.min(ind, offset)));
        } else if (content.at(-1).trim() && !startsBlock(l) && !NESTED_ITEM.test(l)) {
          content.push(l.trimStart()); // lazy continuation
        } else break;
      }
      const task = TASK.exec(content[0]);
      if (task) content[0] = content[0].slice(task[0].length);
      const type = task ? 'to_do' : /\d/.test(marker) ? 'numbered_list_item' : 'bulleted_list_item';
      out.push(container(type, task ? { checked: task[1] !== ' ' } : {}, parseBlocks(content, refs, depth + 1)));
    } else if (isTableStart(lines, i)) {
      const width = Math.min(tableCells(line).length, MAX_ITEMS); // a row holds at most 100 cells
      const rows = [tableCells(line)];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(tableCells(lines[i]));
      out.push({
        type: 'table',
        table: {
          table_width: width,
          has_column_header: true,
          has_row_header: false,
          children: rows.map((row) => ({ type: 'table_row', table_row: { cells: Array.from({ length: width }, (_, k) => richText(row[k] ?? '', refs).slice(0, MAX_ITEMS)) } })),
        },
      });
    } else if (REF_DEF.test(line)) {
      i++;
    } else {
      const para = [line];
      for (i++; i < lines.length && lines[i].trim() && !SETEXT.test(lines[i]) && !startsBlock(lines[i]) && !isTableStart(lines, i); i++) para.push(lines[i]);
      if (i < lines.length && (m = SETEXT.exec(lines[i]))) {
        out.push(...heading(m[1][0] === '=' ? 1 : 2, joinLines(para), refs));
        i++;
      } else out.push(...paragraph(para, refs));
    }
  }
  return out;
}

/**
 * Lines without block-level HTML comments (`<!-- … -->` alone on a line, or from a line opening `<!--` through the first
 * line holding `-->`) outside fenced code. Unclosed openers and comments inside paragraphs stay as text.
 */
function dropComments(lines) {
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
    } else if (f) fence = f[1];
    else if (/^ {0,3}<!--/.test(line)) {
      const rest = line.slice(line.indexOf('<!--') + 4);
      if (rest.includes('-->')) {
        if (/-->\s*$/.test(rest)) continue;
      } else {
        let j = i + 1;
        while (j < lines.length && !lines[j].includes('-->')) j++;
        if (j < lines.length) { i = j; continue; }
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Markdown → Notion block objects (request shape, children nested under each block's type, any depth).
 * Headings 1–3 (deeper ones become heading_3), paragraphs, bulleted/numbered/to-do items with nesting, quotes, fenced
 * and indented code (languages mapped to Notion's list, else `plain text`), dividers, external images, GFM tables.
 */
export function markdownToBlocks(markdown) {
  const lines = dropComments(String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n').map(expandTabs));
  const refs = new Map();
  let fence = null;
  for (const line of lines) {
    const m = FENCE.exec(line);
    if (fence) {
      if (m && m[2][0] === fence[0] && m[2].length >= fence.length && !m[3].trim()) fence = null;
    } else if (m && isFence(line)) fence = m[2];
    else {
      const def = REF_DEF.exec(line);
      if (def && !refs.has(normalizeRef(def[1]))) refs.set(normalizeRef(def[1]), def[2]);
    }
  }
  return parseBlocks(lines, refs);
}

const plainOf = (rich) => rich.map((r) => r.text.content).join('');

/**
 * A page for `markdown`: its title (`title`, else the first `# ` heading, else `source`) and its blocks, ending with a
 * "Source: <link>" paragraph. A leading `# ` heading that repeats the title is dropped (Notion shows the title).
 */
export function markdownToPage(markdown, { title, source } = {}) {
  const blocks = markdownToBlocks(markdown);
  const h1 = blocks[0]?.type === 'heading_1' ? plainOf(blocks[0].heading_1.rich_text).trim() : '';
  const name = String(title ?? '').trim() || h1 || String(source ?? '').trim() || 'Untitled';
  if (h1 && h1 === name) blocks.shift();
  if (source) blocks.push({ type: 'paragraph', paragraph: { rich_text: [textItem('Source: ', {}), ...plainRichText(source, source)] } });
  return { title: name, blocks };
}

// ——— Notion REST API ———

/** A failed Notion request. `status` is the HTTP status (0 when Notion couldn't be reached), `code` Notion's error code. */
export class NotionError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'NotionError';
    this.status = status;
    this.code = code;
  }
}

function failure(status, data, creating) {
  const code = typeof data?.code === 'string' ? data.code : '';
  const detail = typeof data?.message === 'string' && data.message ? `: ${data.message}` : '';
  if (status === 401) return new NotionError(`Notion didn’t accept the token (401 ${code || 'unauthorized'}).`, status, code);
  if (status === 404 && creating) return new NotionError(`Notion can’t find the parent page (404). Share it with your connection: ••• → Connections → add it.`, status, code);
  if (status === 403) return new NotionError(`Notion refused (403 ${code || 'forbidden'})${detail}. The connection needs the “Insert content” capability and access to the parent page.`, status, code);
  if (status === 429 || status === 529) return new NotionError(`Notion is rate limiting or overloaded (${status} ${code})${detail}. Try again in a minute.`, status, code);
  return new NotionError(`Notion answered ${status}${code ? ` ${code}` : ''}${detail}`, status, code);
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** Notion API requests with retries on 429/529, waiting for Retry-After (else 1, 2, 4… seconds, at most 30). */
function notionClient({ token, fetch: fetchImpl, base, sleep, onWait, retries }) {
  const root = base.replace(/\/+$/, '');
  let requests = 0;
  async function call(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      let res;
      requests++;
      try {
        res = await fetchImpl(`${root}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'notion-version': NOTION_VERSION, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        throw new NotionError(`Couldn’t reach ${root.replace(/^https?:\/\//, '')}. Check your connection.`, 0, 'network');
      }
      const data = await res.json().catch(() => null);
      if (res.ok) return data;
      const blocked = data?.additional_data?.rate_limit_reason === 'public_api_request_blocked';
      if ((res.status === 429 || res.status === 529) && !blocked && attempt < retries) {
        const after = Number(res.headers.get('retry-after') ?? data?.additional_data?.retry_after);
        const seconds = Number.isFinite(after) && after >= 0 ? after : Math.min(2 ** attempt, 30);
        onWait?.(seconds);
        await sleep(seconds * 1000);
        continue;
      }
      throw failure(res.status, data, path === '/v1/pages');
    }
  }
  return { call, count: () => requests };
}

const kidsOf = (block) => block[block.type]?.children ?? [];
const withKids = (block, kids) => {
  const { children, ...data } = block[block.type] ?? {};
  return { ...block, [block.type]: kids.length ? { ...data, children: kids } : data };
};

function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * One block as it can be sent: its leading children that have none of their own come along (two levels per request);
 * the rest (`rest`) are appended to it in follow-up requests once Notion returns its ID.
 */
function piece(block) {
  const kids = kidsOf(block);
  const head = withKids(block, []);
  let bytes = utf8Length(JSON.stringify(head)) + 1;
  let elements = 1;
  let n = 0;
  for (; n < kids.length && n < MAX_ITEMS && !kidsOf(kids[n]).length; n++) {
    const size = utf8Length(JSON.stringify(kids[n])) + 1;
    if (elements + 1 > MAX_ELEMENTS || bytes + size > MAX_BYTES) break;
    bytes += size;
    elements++;
  }
  return { payload: withKids(block, kids.slice(0, n)), rest: kids.slice(n), elements, bytes };
}

/** The blocks from `start` that fit one request: ≤100 blocks, ≤1000 elements, ≤450 KB. */
function batch(blocks, start, stopAtFollowUp) {
  const items = [];
  let elements = 0;
  let bytes = 0;
  let i = start;
  for (; i < blocks.length && items.length < MAX_ITEMS; i++) {
    const p = piece(blocks[i]);
    if (stopAtFollowUp && p.rest.length) break;
    if (items.length && (elements + p.elements > MAX_ELEMENTS || bytes + p.bytes > MAX_BYTES)) break;
    items.push(p);
    elements += p.elements;
    bytes += p.bytes;
  }
  return { items, next: i };
}

const countBlocks = (blocks) => blocks.reduce((n, b) => n + 1 + countBlocks(kidsOf(b)), 0);

/**
 * Creates a page titled `title` under the page `parent` (an ID or URL) with `blocks` (any size or depth), within
 * Notion's limits: the page with as many blocks as one request takes, then appends of ≤100 blocks with at most two
 * levels each, deeper children appended to their parent once it exists. Returns { id, url, blocks, requests }.
 * `onProgress({ done, total })` after each request; `onWait(seconds)` before waiting out a 429.
 */
export async function saveToNotion({ token, parent, title, blocks, fetch: fetchImpl = globalThis.fetch, base = NOTION_API, sleep = wait, onProgress, onWait, retries = 5 }) {
  const parentId = notionPageId(parent);
  if (!parentId) throw new NotionError('The parent must be a Notion page ID or URL.', 0, 'invalid_parent');
  const api = notionClient({ token, fetch: fetchImpl, base, sleep, onWait, retries });
  const total = countBlocks(blocks);
  let done = 0;
  const sent = (items) => {
    done += items.reduce((n, p) => n + p.elements, 0);
    onProgress?.({ done, total });
  };
  const first = batch(blocks, 0, true);
  const page = await api.call('POST', '/v1/pages', {
    parent: { type: 'page_id', page_id: parentId },
    properties: { title: { title: plainRichText(title).slice(0, MAX_ITEMS) } },
    ...(first.items.length && { children: first.items.map((p) => p.payload) }),
  });
  if (typeof page?.id !== 'string') throw new NotionError('Unexpected answer from Notion: no page ID.', 200, 'unexpected');
  sent(first.items);
  async function append(parentBlock, list) {
    for (let i = 0; i < list.length; ) {
      const { items, next } = batch(list, i, false);
      const res = await api.call('PATCH', `/v1/blocks/${parentBlock}/children`, { children: items.map((p) => p.payload) });
      sent(items);
      for (const [k, item] of items.entries()) {
        if (!item.rest.length) continue;
        const id = res?.results?.[k]?.id;
        if (typeof id !== 'string') throw new NotionError('Unexpected answer from Notion: no block IDs.', 200, 'unexpected');
        await append(id, item.rest);
      }
      i = next;
    }
  }
  try {
    await append(page.id, blocks.slice(first.next));
  } catch (err) {
    if (err instanceof NotionError) err.message += ` The page was created but is incomplete: ${page.url ?? page.id}`;
    throw err;
  }
  return { id: page.id, url: page.url ?? `https://app.notion.com/p/${page.id.replace(/-/g, '')}`, blocks: total, requests: api.count() };
}
