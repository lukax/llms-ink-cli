// A stand-in for the llms.ink API: /api/llms, /api/check (GET and POST), /api/frame and /api/media, with the same answer shapes.
import { createServer } from 'node:http';

export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(40_000, 3)]);
export const MP4 = Buffer.alloc(120_000, 9);
export const LLMS = '# llms.txt\n\n> A proposal for LLM-friendly content.\n\n## Docs\n\n- [Proposal](https://llmstxt.org/index.md): The proposal\n';
export const FULL = `${LLMS}\n---\n\n# Proposal\n\nThe full text.\n`;
/** The one API key the stand-in accepts. */
export const KEY = `lk_${'a1'.repeat(16)}`;

/** A small llms.txt reader for the stand-in, with the API's `parsed` shape. Null when there's no title and no section. */
export function parseLlms(text, base) {
  const parsed = { title: null, summary: null, details: null, sections: [] };
  const details = [];
  let section = null;
  const resolveUrl = (href) => { try { return new URL(href, base ?? undefined).href; } catch { return href; } };
  text.split(/\r?\n/).forEach((line, i) => {
    let m;
    if (!parsed.title && !section && (m = /^# (.+)/.exec(line))) parsed.title = m[1].trim();
    else if ((m = /^## (.+)/.exec(line))) parsed.sections.push((section = { name: m[1].trim(), optional: /^optional$/i.test(m[1].trim()), text: null, links: [] }));
    else if (!section && parsed.summary === null && (m = /^> ?(.*)/.exec(line))) parsed.summary = m[1].trim();
    else if (section && (m = /^\s*- \[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?/.exec(line))) section.links.push({ title: m[1], url: resolveUrl(m[2]), notes: m[3]?.trim() || null, line: i + 1 });
    else if (line.trim() && section) section.text = section.text ? `${section.text}\n${line}` : line;
    else if (line.trim()) details.push(line);
  });
  parsed.details = details.join('\n').trim() || null;
  return parsed.title || parsed.sections.length ? parsed : null;
}

/** One live session as /live/watch sends it: an earlier line and section (context), then news, then the end. */
export const LIVE_EVENTS = (startedAt) => [
  { type: 'state', seq: 4, status: 'watching', detail: '', live: true, signedIn: true, endsAt: null, transcript: { url: 'https://www.twitch.tv/somechannel', platform: 'twitch', title: 'Dev stream', uploader: 'somechannel', startedAt, updatedAt: startedAt, segments: [{ start: 0, end: 7, text: 'Welcome back everyone.' }], summary: 'Intro.', now: 'Saying hello', sections: { [Date.parse(startedAt)]: { title: 'Hello', gist: 'Greetings.' } } } },
  { type: 'ping', seq: 4 },
  { type: 'segments', seq: 5, segments: [{ start: 0, end: 7, text: 'Welcome back everyone.' }, { start: 7, end: 14, text: 'Today we talk pricing.' }] },
  { type: 'summary', seq: 6, summary: 'Pric', now: 'Pri', done: false },
  { type: 'summary', seq: 7, summary: 'They discuss pricing.', now: 'Talking pricing', done: true, at: '2026-11-24T12:00:20.000Z' },
  { type: 'segments', seq: 8, segments: [{ start: 14, end: 21, text: 'The release date is Friday.' }] },
  { type: 'chat', seq: 9, messages: [{ at: 1, user: 'a', text: 'hi' }], count: 1 },
  { type: 'chatThinks', seq: 10, thinks: { mood: 'excited', themes: [{ title: 'Release', share: 60, quote: 'finally' }], at: '2026-11-24T12:00:30.000Z', messages: 10 } },
  { type: 'sections', seq: 11, sections: { [Date.parse(startedAt)]: { title: 'Hello', gist: 'Greetings.' }, [Date.parse(startedAt) + 300000]: { title: 'Launch plans', gist: 'Ships Friday.' } } },
  { type: 'status', seq: 12, status: 'ended', detail: 'The session ended.' },
];

export async function startMock() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      path: url.pathname, query: Object.fromEntries(url.searchParams),
      ...(req.headers.authorization && { authorization: req.headers.authorization }),
      ...(req.method !== 'GET' && { method: req.method, type: req.headers['content-type'], body }),
    });
    const json = (status, value) => {
      // Errors as the API sends them: RFC 9457 problem details.
      if (status >= 400) {
        const code = { 401: 'invalid_key', 404: 'not_found', 413: 'too_large', 415: 'unsupported_media_type', 422: 'unprocessable', 429: 'quota_exceeded', 500: 'internal' }[status] ?? 'invalid_request';
        res.writeHead(status, { 'content-type': 'application/problem+json' });
        return res.end(JSON.stringify({ type: `https://example.test/docs/#error-${code}`, title: 'Error', status, code, detail: value.error }));
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const link = url.searchParams.get('url') ?? '';
    if (req.headers.authorization && req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: 'That API key isn’t valid or was revoked.' });
    if (link.includes('private')) return json(422, { error: 'That page needs a login; llms.ink only reads public pages.' });
    if (link.includes('limit')) return json(429, { error: 'Daily limit reached (60 new links). Cached links still work.' });
    // Live: a scripted session. `live=offline` is offline; without a key and `start=true`, nothing is running.
    if (url.pathname === '/api/v0/live/watch') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const send = (e) => res.write(`${JSON.stringify(e)}\n`);
      if (link.includes('offline')) { send({ type: 'state', seq: 0, status: 'offline', detail: 'The stream is offline.', live: false, signedIn: false, endsAt: null, transcript: null }); return res.end(); }
      if (!req.headers.authorization) { send({ type: 'state', seq: 0, status: 'idle', detail: '', live: true, signedIn: false, endsAt: null, transcript: null }); return res.end(); }
      const startedAt = '2026-11-24T12:00:00.000Z';
      for (const e of LIVE_EVENTS(startedAt)) send(e);
      return res.end();
    }
    if (url.pathname === '/api/v0/llms') {
      const full = url.searchParams.get('mode') === 'full';
      return json(200, { url: 'https://llmstxt.org/', kind: 'site', source: 'native', mode: full ? 'full' : 'llms', title: 'llms.txt', text: full ? FULL : LLMS, tokens: full ? 1234 : 52, pages: full ? 3 : 1, model: null, cached: !url.searchParams.has('fresh'), generatedAt: '2026-11-13T00:00:00.000Z' });
    }
    const summarize = (issues) => ({ errors: issues.filter((i) => i.level === 'error').length, warnings: issues.filter((i) => i.level === 'warning').length });
    if (url.pathname === '/api/v0/check' && req.method === 'POST') {
      // The text is checked as sent; with links=true, a link with "gone" in it answers 404.
      if (!/^text\/(plain|markdown)\b/.test(req.headers['content-type'] ?? '')) return json(415, { error: 'Send the llms.txt as text/plain or text/markdown.' });
      if (!body.trim()) return json(400, { error: 'Send the llms.txt text in the body.' });
      const base = url.searchParams.get('base');
      if (base !== null && !/^https?:\/\/[^/]+/.test(base)) return json(400, { error: 'base: use a public http(s) URL.' });
      const checkLinks = url.searchParams.get('links') === 'true';
      const parsed = parseLlms(body, base);
      const all = parsed?.sections.flatMap((s) => s.links) ?? [];
      const broken = checkLinks ? all.filter((l) => l.url.includes('gone')).map((l) => ({ url: l.url, status: 404 })) : [];
      const issues = [
        ...(parsed?.title ? [] : [{ level: 'error', code: 'missing_title', line: 1, message: 'Start with a # title.' }]),
        ...(parsed?.title && !parsed.summary ? [{ level: 'warning', code: 'missing_summary', line: null, message: 'No summary blockquote under the title.' }] : []),
        ...broken.map((b) => ({ level: 'error', code: 'broken_link', line: all.find((l) => l.url === b.url).line, message: `${b.url} answers HTTP ${b.status}.` })),
      ];
      return json(200, {
        site: base && new URL(base).origin, url: base, found: true, status: null, title: parsed?.title ?? null, tokens: Math.ceil(body.length / 4),
        sections: parsed?.sections.length ?? 0, links: { total: all.length, checked: checkLinks ? all.length : 0, broken },
        llmsFull: base && checkLinks ? false : null, issues, summary: summarize(issues), parsed, checkedAt: '2026-11-14T00:00:00.000Z',
      });
    }
    if (url.pathname === '/api/v0/check') {
      // "broken" in the link: a 404 link (an error); "slow": a link that didn't answer (a warning); "warn": a warning only; "missing": no llms.txt.
      if (link.includes('missing')) {
        const issues = [{ level: 'error', code: 'not_found', line: null, message: 'No llms.txt at https://llmstxt.org/llms.txt (HTTP 404).' }];
        return json(200, { site: 'https://llmstxt.org', url: 'https://llmstxt.org/llms.txt', found: false, status: 404, title: null, tokens: 0, sections: 0, links: { total: 0, checked: 0, broken: [] }, llmsFull: false, issues, summary: summarize(issues), parsed: null, checkedAt: '2026-11-14T00:00:00.000Z' });
      }
      const broken = link.includes('broken') ? [{ url: 'https://llmstxt.org/gone.md', status: 404 }] : link.includes('slow') ? [{ url: 'https://llmstxt.org/slow.md', status: 0 }] : [];
      const issues = [
        ...broken.map((b) => (b.status ? { level: 'error', code: 'broken_link', line: 7, message: `${b.url} answers HTTP ${b.status}.` } : { level: 'warning', code: 'unreachable_link', line: 8, message: `${b.url} didn’t answer in 8s.` })),
        ...(link.includes('warn') ? [{ level: 'warning', code: 'missing_summary', line: null, message: 'No summary blockquote under the title.' }] : []),
      ];
      return json(200, {
        site: 'https://llmstxt.org', url: 'https://llmstxt.org/llms.txt', found: true, status: 200, title: 'llms.txt', tokens: 52, sections: 1,
        links: { total: 3, checked: 3, broken }, llmsFull: false, issues, summary: summarize(issues),
        parsed: parseLlms(LLMS, 'https://llmstxt.org/llms.txt'), checkedAt: '2026-11-14T00:00:00.000Z',
      });
    }
    if (url.pathname === '/api/v0/report') {
      // "blocked" in the link: robots.txt keeps a search bot out (a fail, with a robots.txt patch); else warnings only.
      const blocked = link.includes('blocked');
      const checks = [
        blocked
          ? { id: 'bots-search', status: 'fail', title: 'AI search crawlers', detail: 'robots.txt keeps OAI-SearchBot from this page.', evidence: 'OAI-SearchBot: blocked by line 2 `Disallow: /`', fix: { kind: 'robots', summary: 'Allow OAI-SearchBot in robots.txt.', patch: { file: '/robots.txt', content: 'User-agent: OAI-SearchBot\nAllow: /\n' } } }
          : { id: 'bots-search', status: 'pass', title: 'AI search crawlers', detail: 'robots.txt lets every AI search crawler read this page.' },
        { id: 'bots-training', status: 'info', title: 'Training crawlers', detail: 'All 6 training crawlers may use this page.', fix: { kind: 'robots', summary: 'Your call.' } },
      ];
      const page = { id: 'raw-text', status: 'warn', title: 'Text without JavaScript', detail: 'Only 90 words in the HTML.', fix: { kind: 'html', summary: 'Render on the server.' } };
      const sections = [{ id: 'access', title: 'Access', checks }, { id: 'rendering', title: 'Rendering', checks: [page] }];
      const all = sections.flatMap((s) => s.checks);
      const summary = Object.fromEntries(['pass', 'warn', 'fail', 'info'].map((k) => [k, all.filter((c) => c.status === k).length]));
      return json(200, { url: `https://${link.replace(/^https?:\/\//, '')}`, site: `https://${link.replace(/^https?:\/\//, '').split('/')[0]}`, checkedAt: '2026-11-14T00:00:00.000Z', summary, sections });
    }
    if (url.pathname === '/api/v0/frame') {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(JPEG.length), 'content-disposition': `inline; filename="frame-${Number(url.searchParams.get('t')?.split(':').reduce((a, b) => a * 60 + Number(b), 0) ?? 0)}s.jpg"` });
      return res.end(JPEG);
    }
    if (url.pathname === '/api/v0/media') {
      const audio = url.searchParams.get('format') === 'm4a';
      res.writeHead(200, { 'content-type': audio ? 'audio/mp4' : 'video/mp4', 'content-length': String(MP4.length), 'content-disposition': `attachment; filename="Me at the zoo.${audio ? 'm4a' : 'mp4'}"; filename*=UTF-8''Me%20at%20the%20zoo.${audio ? 'm4a' : 'mp4'}` });
      return res.end(MP4);
    }
    if (url.pathname === '/api/v0/generate') {
      // Drafts by kind, shaped like the API's; "empty" in the link: nothing to draft.
      const kind = url.searchParams.get('kind');
      const cite = (f) => ({ for: f, url: 'https://github.com/acme/widget/blob/main/package.json#L4', line: 4, quote: '"build": "tsc"' });
      const drafts = link.includes('empty') ? [] : {
        'agents-md': [{ title: 'AGENTS.md', format: 'markdown', content: '# AGENTS.md\n\n## Commands\n\n- `npm run build`: `tsc` <!-- package.json:4 -->\n', cites: [cite('`npm run build`: `tsc`')] }],
        jsonld: [{ title: 'WebSite', format: 'json', content: '{\n  "@context": "https://schema.org",\n  "@type": "WebSite",\n  "name": "Widget"\n}', cites: [cite('WebSite.name')] }, { title: 'Organization', format: 'json', content: '{"@context":"https://schema.org","@type":"Organization","name":"Widget"}', cites: [cite('Organization.name')] }],
        'alt-text': [{ title: '/chart.png', format: 'text', content: 'Bar chart of "sales" by quarter', target: '/chart.png', cites: [cite('alt')] }],
        answers: [{ title: 'Installation', format: 'markdown', content: '## How do you install Widget?\n\nRun `npm i widget`.\n', target: 'Installation', cites: [cite('answer')] }],
      }[kind];
      if (!drafts) return json(400, { error: 'kind must be agents-md, jsonld, alt-text or answers.' });
      return json(200, { kind, url: 'https://github.com/acme/widget', title: 'acme/widget', drafts, sources: [{ url: 'https://github.com/acme/widget/blob/main/package.json', title: 'package.json' }], notes: link.includes('empty') ? ['No H2 sections with text on this page.'] : ['1 model line rejected: not supported by the sources.'], model: 'stub/model', cached: !url.searchParams.has('fresh'), generatedAt: '2026-11-14T00:00:00.000Z' });
    }
    json(404, { error: 'Not found.' });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ api: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((d) => server.close(d)) })));
}
