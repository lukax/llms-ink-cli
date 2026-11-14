// Minimal TOML reader for manifests (pyproject.toml, Cargo.toml); same reader as integrations/shared/ink.mjs.
/** Minimal TOML reader for dependency tables: tables, dotted/quoted keys, strings, arrays, inline tables. */
export function parseToml(text) {
  const root = {}; let table = root;
  const keyPath = raw => { const keys = []; let rest = raw.trim(); while (rest) { const m = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|$)/.exec(rest); if (!m) throw new Error(`Invalid TOML key: ${raw.trim()}`); keys.push(m[1] ?? m[2] ?? m[3]); rest = rest.slice(m[0].length); } return keys; };
  const descend = (obj, keys, array = false) => {
    let node = obj;
    keys.forEach((k, i) => {
      const last = i === keys.length - 1;
      if (last && array) { if (!Array.isArray(node[k])) node[k] = []; node[k].push({}); node = node[k].at(-1); return; }
      if (node[k] === undefined) node[k] = {};
      node = Array.isArray(node[k]) ? node[k].at(-1) : node[k];
      if (typeof node !== 'object' || node === null) throw new Error(`TOML key conflict at ${keys.join('.')}`);
    });
    return node;
  };
  const value = src => {
    let i = 0;
    const ws = () => { for (;;) { while (i < src.length && /\s/.test(src[i])) i++; if (src[i] !== '#') return; while (i < src.length && src[i] !== '\n') i++; } };
    const eof = () => { if (i >= src.length) throw Object.assign(new Error('Unterminated TOML value.'), { eof: true }); };
    const basic = s => s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/gs, (_, e) => ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\' })[e] ?? (/^[uU]/.test(e) ? String.fromCodePoint(parseInt(e.slice(1), 16)) : e));
    const read = () => {
      ws(); eof();
      for (const q of ['"""', "'''"]) if (src.startsWith(q, i)) { const end = src.indexOf(q, i + 3); if (end < 0) { i = src.length; eof(); } const s = src.slice(i + 3, end).replace(/^\r?\n/, ''); i = end + 3; return q === '"""' ? basic(s) : s; }
      if (src[i] === '"') { let j = i + 1; while (j < src.length && src[j] !== '"' && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1; if (src[j] !== '"') throw new Error('Unterminated TOML string.'); const s = src.slice(i + 1, j); i = j + 1; return basic(s); }
      if (src[i] === "'") { const end = src.indexOf("'", i + 1); if (end < 0 || src.slice(i, end).includes('\n')) throw new Error('Unterminated TOML string.'); const s = src.slice(i + 1, end); i = end + 1; return s; }
      if (src[i] === '[') { i++; const out = []; for (;;) { ws(); eof(); if (src[i] === ']') { i++; return out; } out.push(read()); ws(); eof(); if (src[i] === ',') i++; else if (src[i] !== ']') throw new Error('Invalid TOML array.'); } }
      if (src[i] === '{') {
        i++; const out = {};
        for (;;) {
          ws(); eof(); if (src[i] === '}') { i++; return out; }
          const eq = src.indexOf('=', i); if (eq < 0) throw new Error('Invalid TOML inline table.');
          const keys = keyPath(src.slice(i, eq)); i = eq + 1; const v = read();
          const parent = descend(out, keys.slice(0, -1)); parent[keys.at(-1)] = v;
          ws(); eof(); if (src[i] === ',') i++; else if (src[i] !== '}') throw new Error('Invalid TOML inline table.');
        }
      }
      const m = /^[^\s,\]}#]+/.exec(src.slice(i)); if (!m) throw new Error('Invalid TOML value.');
      i += m[0].length; return m[0] === 'true' ? true : m[0] === 'false' ? false : m[0];
    };
    const v = read(); ws(); if (i < src.length) throw new Error('Unexpected text after a TOML value.'); return v;
  };
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const current = lines[n].trim();
    if (!current || current.startsWith('#')) continue;
    let m;
    if ((m = /^\[\[\s*([^\]]+?)\s*\]\]\s*(?:#.*)?$/.exec(current))) { table = descend(root, keyPath(m[1]), true); continue; }
    if ((m = /^\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(current))) { table = descend(root, keyPath(m[1])); continue; }
    const eq = /^(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^=])*?=/.exec(current);
    if (!eq) throw new Error(`Invalid TOML on line ${n + 1}.`);
    const keys = keyPath(eq[0].slice(0, -1));
    let src = current.slice(eq[0].length), parsed, start = n;
    for (;;) {
      try { parsed = value(src); break; } catch (err) { if (!err.eof || n + 1 >= lines.length || n - start > 5000) throw new Error(`${err.message} (line ${start + 1})`); src += '\n' + lines[++n]; }
    }
    descend(table, keys.slice(0, -1))[keys.at(-1)] = parsed;
  }
  return root;
}
