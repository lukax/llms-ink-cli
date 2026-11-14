// Trims an llms-full.txt to the index plus the sections that mention the symbols the code uses, within a token budget.

/** Rough tokens for English and code: 4 characters each. */
export const tokensOf = (text) => Math.ceil(text.length / 4);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A bare name worth matching on its own: long enough or shaped like an identifier (camelCase, snake_case). */
const distinctive = (s) => s.length >= 5 || /[A-Z_]/.test(s.slice(1));

/**
 * A test for one symbol: `z.object` matches `z.object` (or a distinctive leaf like `safeParse` alone); a bare name
 * matches as a whole word. Names under 2 characters never match on their own (too common).
 */
export function symbolTest(symbol) {
  const word = (s) => new RegExp(`(?<![\\w$])${escape(s)}(?![\\w$])`);
  const tests = [];
  if (symbol.length >= 2) tests.push(word(symbol));
  const leaf = symbol.split(/[./:]+/).at(-1);
  if (leaf && leaf !== symbol && distinctive(leaf)) tests.push(word(leaf));
  return (text) => tests.some((t) => t.test(text));
}

/** Lines outside fenced code, with a flag per line. */
function fenced(lines) {
  let open = null;
  return lines.map((line) => {
    const m = /^\s*(```+|~~~+)/.exec(line);
    const inside = open !== null;
    if (m && (open === null || m[1][0] === open[0])) open = open === null ? m[1] : null;
    return inside || m !== null;
  });
}

/** A `---` line that starts a page in llms.ink's llms-full.txt: followed by `Source:` (optionally after a `# ` title). */
function startsPage(lines, i) {
  const next = [];
  for (let j = i + 1; j < lines.length && next.length < 2; j++) if (lines[j].trim()) next.push(lines[j]);
  return /^Source: /.test(next[0] ?? '') || (/^# /.test(next[0] ?? '') && /^Source: /.test(next[1] ?? ''));
}

function parsePage(lines) {
  let title = null;
  let source = null;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!source && /^Source: /.test(line)) source = line.slice(8).trim();
    else if (!title && /^# /.test(line)) title = line.slice(2).trim();
    else break;
  }
  const body = lines.slice(i);
  const inCode = fenced(body);
  const sections = [];
  let current = { heading: null, lines: [] };
  body.forEach((line, j) => {
    if (!inCode[j] && /^#{1,3}\s/.test(line)) {
      if (current.lines.some((l) => l.trim())) sections.push(current);
      current = { heading: line.replace(/^#+\s*/, '').trim(), lines: [] };
    }
    current.lines.push(line);
  });
  if (current.lines.some((l) => l.trim())) sections.push(current);
  return { title, source, sections: sections.map((s) => ({ heading: s.heading, text: s.lines.join('\n').trim() })) };
}

/** llms-full.txt → `{ index, pages: [{ title, source, sections: [{ heading, text }] }] }`. */
export function splitFull(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const inCode = fenced(lines);
  let cuts = lines.flatMap((l, i) => (!inCode[i] && l.trim() === '---' && startsPage(lines, i) ? [i] : []));
  if (!cuts.length) {
    // One document (a page body after its index, or a site's own llms-full.txt): the index ends at the first --- or ##.
    const hr = lines.findIndex((l, i) => !inCode[i] && l.trim() === '---');
    const h2 = lines.findIndex((l, i) => !inCode[i] && /^## /.test(l));
    cuts = hr > 0 ? [hr] : [];
    if (!cuts.length) {
      const pages = h2 >= 0 ? [parsePage(lines.slice(h2))] : [];
      return { index: lines.slice(0, h2 >= 0 ? h2 : lines.length).join('\n').trim(), pages };
    }
  }
  const pages = cuts.map((at, k) => parsePage(lines.slice(at + 1, cuts[k + 1] ?? lines.length)));
  return { index: lines.slice(0, cuts[0]).join('\n').trim(), pages };
}

/** Text cut to about `tokens`, at a line end. */
function clip(text, tokens) {
  if (tokensOf(text) <= tokens) return text;
  const cut = text.slice(0, Math.max(0, tokens * 4 - 16));
  return `${cut.slice(0, Math.max(cut.lastIndexOf('\n'), 0)).trimEnd()}\n\n[…truncated]`;
}

const byUrl = (a, b) => ((a.source ?? '') < (b.source ?? '') ? -1 : (a.source ?? '') > (b.source ?? '') ? 1 : 0);

/** 0 docs, 1 project housekeeping (contributing, security…), 2 changelogs: the order sections are picked in. */
export function pageTier({ title, source }) {
  const name = `${(source ?? '').split(/[?#]/)[0].split('/').at(-1) ?? ''} ${title ?? ''}`;
  if (/(?:^|[^a-z])(?:change ?log|changes|history|releases?|release[-_ ]notes|news)(?:[^a-z]|$)/i.test(name)) return 2;
  if (/contributing|maintainers|code[-_ ]of[-_ ]conduct|security|governance|support|agents\.md|claude\.md/i.test(name)) return 1;
  return 0;
}

const pageHeader = ({ title, source }) => `---\n\n${title ? `# ${title}\n\n` : ''}${source ? `Source: ${source}` : ''}`.trimEnd();

/**
 * Keeps the index and the sections mentioning `symbols` (docs before housekeeping before changelogs, then the most
 * symbols matched) until `maxTokens`, then prints them in document order under their page. `native`: the index is
 * the publisher's own llms.txt (kept as written); otherwise it's generated per request, so it's replaced by a page
 * list and pages are sorted by URL, keeping reruns stable. With no symbols, the docs' first sections fill the budget.
 */
export function trimDocs(text, { symbols = [], maxTokens = 6000, native = false } = {}) {
  const { index, pages } = splitFull(text);
  if (!native) pages.sort(byUrl);
  const indexText = native
    ? index
    : pages.length
      ? `## Pages\n\n${pages.map((p) => `- ${p.source ? `[${p.title ?? p.source}](${p.source})` : p.title ?? 'Untitled'}`).join('\n')}`
      : '';
  const head = clip(indexText, Math.floor(maxTokens / 4));
  let budget = maxTokens - tokensOf(head);
  const tests = symbols.map((s) => [s, symbolTest(s)]);
  const tiers = pages.map(pageTier);
  const all = pages.flatMap((page, p) => page.sections.map((section, s) => {
    const haystack = `${s === 0 && page.title ? `${page.title}\n` : ''}${section.text}`;
    const matched = tests.filter(([, test]) => test(haystack)).map(([name]) => name);
    return { p, s, text: section.text, matched, tokens: tokensOf(`\n\n${section.text}`) };
  }));
  const byRank = (a, b) => tiers[a.p] - tiers[b.p] || b.matched.length - a.matched.length || a.p - b.p || a.s - b.s;
  const candidates = symbols.length ? all.filter((c) => c.matched.length).sort(byRank) : [...all].sort((a, b) => tiers[a.p] - tiers[b.p] || a.p - b.p || a.s - b.s);
  const kept = [];
  const opened = new Set();
  for (const c of candidates) {
    const cost = c.tokens + (opened.has(c.p) ? 0 : tokensOf(`\n\n${pageHeader(pages[c.p])}`));
    if (budget - (cost - c.tokens) <= 40) continue;
    if (cost <= budget) kept.push(c);
    else if (!kept.length) kept.push({ ...c, text: clip(c.text, budget - (cost - c.tokens) - 8) });
    else continue;
    budget -= Math.min(cost, budget);
    opened.add(c.p);
  }
  kept.sort((a, b) => a.p - b.p || a.s - b.s);
  const parts = [];
  let page = -1;
  for (const c of kept) {
    if (c.p !== page) parts.push(pageHeader(pages[(page = c.p)]));
    parts.push(c.text);
  }
  const matched = [...new Set(kept.flatMap((c) => c.matched))].sort((a, b) => symbols.indexOf(a) - symbols.indexOf(b));
  const body = [head, ...parts].filter(Boolean).join('\n\n');
  return { text: body, matched, kept: kept.length, matching: symbols.length ? candidates.length : 0, total: all.length, tokens: tokensOf(body) };
}
