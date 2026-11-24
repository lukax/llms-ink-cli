// llms-ink listen: follow a live stream (GET /api/v0/live/watch) and print one line per event worth waking an agent for.
// The API sends everything (every 7-second transcript line, partial summaries, pings); this keeps what a listener acts on.

/** Statuses after which a session is over. */
const OVER = new Set(['ended', 'offline', 'error', 'busy']);

/**
 * Turns the API's live events into listener events. `take(event)` returns `{ out, stop }`: the events to print, and
 * when to stop (`{ code, message?, ended? }`). `pattern` (a RegExp) keeps only events whose text matches, plus status
 * changes; `until` stops after the first match. `lines` prints every transcript line (they are always checked
 * against the pattern). `signedIn`: whether this caller could start a session.
 */
export function listener({ pattern = null, until = false, lines = false, signedIn = false } = {}) {
  let status = null;
  let watched = false;
  let startedAt = null;
  let lastEnd = -1;
  const sections = new Set();

  const at = (seconds) => (startedAt == null ? null : new Date(startedAt + seconds * 1000).toISOString());
  const found = (text) => {
    if (!pattern) return null;
    pattern.lastIndex = 0;
    return pattern.exec(text)?.[0] ?? null;
  };

  /** A listener event, or null when the pattern leaves it out. `always` events (lines without a pattern) are opt-in. */
  function keep(event, text, shown = true) {
    if (!pattern) return shown ? [event] : [];
    const match = found(text);
    return match == null ? [] : [{ ...event, match }];
  }

  function changeStatus(next, detail, extra = {}) {
    if (!next || next === status) return { out: [], stop: null };
    status = next;
    if (next === 'watching') watched = true;
    const out = [{ event: 'status', status: next, ...(detail && { detail }), ...extra }];
    let stop = null;
    if (next === 'ended') stop = { code: 0, ended: true };
    else if (next === 'offline') stop = watched ? { code: 0, ended: true } : { code: 1, message: detail || 'The stream is offline.' };
    else if (next === 'busy' || next === 'error') stop = { code: 1, message: detail || `The session stopped (${next}).` };
    else if (next === 'idle' && !signedIn) stop = { code: 2, message: 'Nobody is listening to this stream right now. Starting a session needs an API key: --key or LLMS_INK_KEY.' };
    else if (next === 'idle') stop = { code: 1, message: detail || 'The session didn’t start.' };
    return { out, stop };
  }

  function segmentsOut(segments = []) {
    const out = [];
    for (const s of segments) {
      if (!(s.end > lastEnd) || !s.text?.trim()) continue;
      lastEnd = s.end;
      if (startedAt == null) startedAt = Date.now() - s.end * 1000;
      out.push(...keep({ event: 'line', at: at(s.start), text: s.text.trim() }, s.text, lines));
    }
    return out;
  }

  function sectionsOut(record = {}) {
    const out = [];
    for (const key of Object.keys(record).sort((a, b) => Number(a) - Number(b))) {
      if (sections.has(key)) continue;
      sections.add(key);
      const { title, gist } = record[key];
      out.push(...keep({ event: 'section', at: new Date(Number(key)).toISOString(), title, gist }, `${title}\n${gist}`));
    }
    return out;
  }

  function take(e) {
    if (!e || typeof e !== 'object') return { out: [], stop: null };
    if (e.type === 'state') {
      const t = e.transcript;
      if (t?.startedAt) startedAt = Date.parse(t.startedAt);
      // What came before connecting is context, not news: mark it seen.
      for (const s of t?.segments ?? []) lastEnd = Math.max(lastEnd, s.end);
      for (const key of Object.keys(t?.sections ?? {})) sections.add(key);
      const info = t ? { title: t.title, uploader: t.uploader, url: t.url, ...(t.now && { now: t.now }) } : {};
      const result = changeStatus(e.status, e.detail || e.error?.detail, info);
      return result;
    }
    if (e.type === 'status') return changeStatus(e.status, e.detail || e.error?.detail);
    if (e.type === 'segments') return { out: segmentsOut(e.segments), stop: null };
    if (e.type === 'sections') return { out: sectionsOut(e.sections), stop: null };
    if (e.type === 'summary' && e.done) {
      return { out: keep({ event: 'summary', at: e.at ?? new Date().toISOString(), now: e.now, summary: e.summary }, `${e.now}\n${e.summary}`), stop: null };
    }
    // What chat thinks, without anyone's words: the mood and its themes.
    if (e.type === 'chatThinks' && e.thinks) {
      const { mood, themes = [], at: when } = e.thinks;
      const brief = themes.map(({ title, share }) => ({ title, share }));
      return { out: keep({ event: 'chat', at: when, mood, themes: brief }, [mood, ...brief.map((x) => x.title)].join('\n')), stop: null };
    }
    return { out: [], stop: null };
  }

  /** After `out`, whether --until is met. */
  const met = (out) => until && out.some((x) => x.match != null);
  return { take, met, get status() { return status; } };
}

/** One listener event as a line for people: time, kind, text. */
export function textLine(e) {
  const time = e.at ? new Date(e.at).toTimeString().slice(0, 8) : '        ';
  const body = {
    status: () => [e.status, e.title && `${e.title}${e.uploader ? ` (${e.uploader})` : ''}`, e.detail].filter(Boolean).join(' · '),
    line: () => e.text,
    section: () => `${e.title}: ${e.gist}`,
    summary: () => e.now || e.summary,
    chat: () => `${e.mood}${e.themes.length ? ` (${e.themes.map((t) => `${t.title} ${t.share}%`).join(', ')})` : ''}`,
  }[e.event]?.() ?? '';
  return `${time}  ${e.event.padEnd(7)}  ${body}`;
}

/** The non-empty lines of a streamed response body. */
export async function* streamLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) yield line;
      }
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    reader.cancel().catch(() => {});
  }
}
