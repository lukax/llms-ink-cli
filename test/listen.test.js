import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { main } from '../src/cli.js';
import { listener } from '../src/listen.js';
import { KEY, LIVE_EVENTS, startMock } from './mock.js';

const LINK = 'twitch.tv/somechannel';
let mock;
test.before(async () => { mock = await startMock(); });
test.after(async () => { await mock.close(); });
test.beforeEach(() => { mock.requests.length = 0; });

function capture() {
  const chunks = [];
  const stream = new Writable({ write(chunk, _enc, done) { chunks.push(String(chunk)); done(); } });
  Object.defineProperty(stream, 'text', { get: () => chunks.join('') });
  return stream;
}
async function cli(argv, env = { LLMS_INK_KEY: KEY }) {
  const stdout = capture();
  const stderr = capture();
  const code = await main({ argv, env: { LLMS_INK_API: mock.api, ...env }, stdout, stderr });
  return { code, stdout: stdout.text, stderr: stderr.text, events: stdout.text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return l; } }) };
}

test('listen --json prints status, new sections, finished summaries and chat mood; not what came before, partials or chat words', async () => {
  const { code, events, stderr } = await cli(['listen', LINK, '--json']);
  assert.equal(code, 0);
  assert.deepEqual(events.map((e) => e.event), ['status', 'summary', 'chat', 'section', 'status']);
  assert.equal(events[0].status, 'watching');
  assert.equal(events[0].title, 'Dev stream');
  assert.equal(events[1].summary, 'They discuss pricing.');
  assert.deepEqual(events[2].themes, [{ title: 'Release', share: 60 }]);
  assert.equal(events[3].title, 'Launch plans');
  assert.equal(events[4].status, 'ended');
  assert.ok(!JSON.stringify(events).includes('finally'), 'no chat quotes');
  assert.match(stderr, /Listening to Dev stream/);
  assert.deepEqual(mock.requests[0], { path: '/api/v0/live/watch', query: { url: LINK, start: 'true' }, authorization: `Bearer ${KEY}` });
});

test('--lines adds new transcript lines with their time', async () => {
  const { events } = await cli(['listen', LINK, '--json', '--lines']);
  const lines = events.filter((e) => e.event === 'line');
  assert.deepEqual(lines.map((l) => l.text), ['Today we talk pricing.', 'The release date is Friday.']);
  assert.equal(lines[0].at, '2026-11-24T12:00:07.000Z');
});

test('--match keeps matching events (lines included) and status changes, with what matched', async () => {
  const { code, events } = await cli(['listen', LINK, '--json', '--match', 'friday']);
  assert.equal(code, 0);
  assert.deepEqual(events.map((e) => [e.event, e.match ?? null]), [['status', null], ['line', 'Friday'], ['section', 'Friday'], ['status', null]]);
});

test('--until stops at the first match with 0, and fails with 1 when the stream ends first', async () => {
  const hit = await cli(['listen', LINK, '--json', '--until', 'release date']);
  assert.equal(hit.code, 0);
  assert.equal(hit.events.at(-1).text, 'The release date is Friday.');
  const miss = await cli(['listen', LINK, '--until', 'refund']);
  assert.equal(miss.code, 1);
  assert.match(miss.stderr, /ended before “refund”/);
});

test('text output is one line per event for people', async () => {
  const { stdout } = await cli(['listen', LINK]);
  assert.match(stdout, /^\d\d:\d\d:\d\d {2}summary {2}Talking pricing$/m);
  assert.match(stdout, /status {3}ended · The session ended\.$/m);
});

test('without a key it only follows; nothing running exits 2 and says a key starts one', async () => {
  const { code, stderr } = await cli(['listen', LINK], {});
  assert.equal(code, 2);
  assert.match(stderr, /needs an API key/);
  assert.deepEqual(mock.requests[0].query, { url: LINK, start: 'false' });
});

test('an offline stream exits 1 with the reason', async () => {
  const { code, stderr } = await cli(['listen', 'twitch.tv/offline']);
  assert.equal(code, 1);
  assert.match(stderr, /offline/);
});

test('usage: listen flags elsewhere, both filters, a bad pattern, --keep without a key, -o', async () => {
  for (const [argv, env, re] of [
    [['example.com', '--match', 'x'], undefined, /are for listen/],
    [['listen', LINK, '--match', 'a', '--until', 'b'], undefined, /not both/],
    [['listen', LINK, '--match', '('], undefined, /--match/],
    [['listen', LINK, '--keep'], {}, /needs an API key/],
    [['listen', LINK, '-o', 'x.txt'], undefined, /redirect/],
    [['listen'], undefined, /Give a live link/],
  ]) {
    const { code, stderr } = await cli(argv, env);
    assert.equal(code, 2, argv.join(' '));
    assert.match(stderr, re);
  }
  assert.equal(mock.requests.length, 0);
});

test('listener: an offline status after watching is the end, not a failure', () => {
  const w = listener({});
  w.take(LIVE_EVENTS('2026-11-24T12:00:00.000Z')[0]);
  assert.deepEqual(w.take({ type: 'status', status: 'offline', detail: 'The stream is offline.' }).stop, { code: 0, ended: true });
});
