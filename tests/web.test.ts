import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SqliteStore } from '../src/adapters/store/sqlite.ts';
import { announcementHtml } from '../src/adapters/telegram/bot.ts';
import { createWebApp, type WebDeps } from '../src/adapters/web/server.ts';
import { ActionError, chatAboutVacancy, decide, KeyedLock } from '../src/core/actions.ts';
import { buildBoardItems, kyivDay, sectionBreakdown } from '../src/core/board.ts';
import type { Llm, StoredVacancy } from '../src/core/ports.ts';
import type { Assessment } from '../src/schemas/assessment.ts';
import type { Vacancy } from '../src/schemas/vacancy.ts';

const assessment = (over: Partial<Assessment> = {}): Assessment => ({
  score: 70,
  verdict: 'apply',
  role: 'backend',
  aiFocus: 'some',
  englishRequired: 'unknown',
  pros: ['NestJS'],
  cons: [],
  summary: 'Бэкенд на Node.js',
  ...over,
});

const vacancy = (id: string, over: Partial<Vacancy> = {}): Vacancy => ({
  key: `djinni:${id}`,
  source: 'djinni',
  externalId: id,
  url: `https://djinni.co/jobs/${id}-x/`,
  title: `Node.js Developer ${id}`,
  company: 'Initech',
  description: 'Node.js',
  publishedAt: new Date('2026-10-01T10:00:00Z'),
  meta: {},
  ...over,
});

/** Stores a vacancy on the board with the given status, score and assessment. */
function seed(store: SqliteStore, id: string, opts: { status?: StoredVacancy['status']; a?: Partial<Assessment>; v?: Partial<Vacancy> } = {}) {
  const v = vacancy(id, opts.v);
  store.insertIfAbsent(v);
  const a = assessment(opts.a);
  store.update(v.key, { status: opts.status ?? 'notified', score: a.score, assessment: a, letter: `Лист ${id}` });
  return v.key;
}

describe('board model', () => {
  it('maps statuses to decisions and leaves non-board statuses out', () => {
    const store = new SqliteStore(':memory:');
    seed(store, '1');
    seed(store, '2', { status: 'applied' });
    seed(store, '3', { status: 'skipped' });
    seed(store, '4', { status: 'low' });
    const items = buildBoardItems(store.listByStatus(['notified', 'applied', 'skipped', 'low']), 'A2');
    assert.deepEqual(items.map((i) => [i.key, i.decision]).sort(), [
      ['djinni:1', 'open'],
      ['djinni:2', 'applied'],
      ['djinni:3', 'skipped'],
    ]);
  });

  it('puts comfortable English first, then by score, and flags stretch', () => {
    const store = new SqliteStore(':memory:');
    seed(store, 'b2-high', { a: { score: 90, englishRequired: 'B2' } });
    seed(store, 'fit-low', { a: { score: 61 } });
    seed(store, 'fit-high', { a: { score: 80, englishRequired: 'A2' } });
    const items = buildBoardItems(store.listByStatus(['notified']), 'A2');
    assert.deepEqual(
      items.map((i) => [i.key, i.stretch]),
      [
        ['djinni:fit-high', false],
        ['djinni:fit-low', false],
        ['djinni:b2-high', true],
      ],
    );
    assert.equal(items[2]?.english, 'B2');
  });

  it('uses the role as the section and formats salary', () => {
    const store = new SqliteStore(':memory:');
    seed(store, '1', { a: { role: 'fullstack' }, v: { meta: { salaryMinUsd: 3000, salaryMaxUsd: 4500 } } });
    const [item] = buildBoardItems(store.listByStatus(['notified']), 'A2');
    assert.equal(item?.section, 'fullstack');
    assert.equal(item?.salary, '$3000–4500');
  });

  it('groups publication time by the Kyiv calendar day', () => {
    // 23:30 UTC on Oct 1 is already Oct 2 in Kyiv (UTC+3).
    assert.equal(kyivDay(new Date('2026-10-01T23:30:00Z')), '2026-10-02');
    assert.equal(kyivDay(new Date('2026-10-01T20:00:00Z')), '2026-10-01');
  });

  it('summarises sections for the notification', () => {
    assert.equal(sectionBreakdown([{ section: 'fullstack' }, { section: 'backend' }, { section: 'fullstack' }]), 'Fullstack 2 · Backend 1');
  });
});

describe('actions', () => {
  it('decide moves between open, applied and skipped, and logs it', () => {
    const store = new SqliteStore(':memory:');
    const key = seed(store, '1');
    assert.equal(decide(store, key, 'applied').status, 'applied');
    assert.equal(decide(store, key, 'open').status, 'notified');
    assert.equal(decide(store, key, 'skipped').status, 'skipped');
    assert.equal(store.countEventsSince('applied', new Date(0)), 1);
  });

  it('decide refuses unknown and non-board vacancies', () => {
    const store = new SqliteStore(':memory:');
    const low = seed(store, '1', { status: 'low' });
    assert.throws(() => decide(store, 'djinni:nope', 'applied'), (e: unknown) => e instanceof ActionError && e.status === 404);
    assert.throws(() => decide(store, low, 'applied'), (e: unknown) => e instanceof ActionError && e.status === 409);
  });

  it('chat updates the letter and keeps history', async () => {
    const store = new SqliteStore(':memory:');
    const key = seed(store, '1');
    const llm = { chat: async () => ({ reply: 'Сократил.', letter: 'Короткий лист' }) } as unknown as Llm;
    const out = await chatAboutVacancy({ store, llm, resume: '', candidateName: 'Іван', neverMention: [] }, key, 'короче');
    assert.equal(out.letter, 'Короткий лист');
    assert.equal(store.get(key)?.letter, 'Короткий лист');
    assert.deepEqual(
      out.history.map((t) => t.role),
      ['user', 'assistant'],
    );
  });

  it('KeyedLock rejects a second job on the same key', async () => {
    const lock = new KeyedLock();
    let release!: () => void;
    const first = lock.run('k', () => new Promise<void>((r) => (release = r)));
    await assert.rejects(lock.run('k', async () => {}), /Уже работаю/);
    await lock.run('other', async () => {});
    release();
    await first;
    await lock.run('k', async () => {});
  });
});

describe('web api', () => {
  const KEY = 'secret-key-123';

  function web(store = new SqliteStore(':memory:'), over: Partial<WebDeps> = {}) {
    const app = createWebApp({
      store,
      llm: {} as Llm,
      resume: '',
      candidateName: 'Іван',
      neverMention: [],
      englishLevel: 'A2',
      contact: { fullName: 'Іван Петренко', phone: '+380 00 123 4567' },
      scanIntervalMinutes: 10,
      accessKey: KEY,
      staticDir: '/nonexistent',
      scan: async () => 'ok',
      isScanning: () => false,
      addFromUrl: async () => {
        throw new Error('not in test');
      },
      now: () => new Date('2026-10-02T09:00:00Z'),
      ...over,
    });
    const cookie = `jh_key=${KEY}`;
    return {
      store,
      get: (path: string, headers: Record<string, string> = { cookie }) => app.request(path, { headers }),
      post: (path: string, body: unknown) =>
        app.request(path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    };
  }

  it('rejects requests without the key and accepts ?k= once, setting a cookie', async () => {
    const { get } = web();
    assert.equal((await get('/api/board', {})).status, 401);
    assert.equal((await get('/api/board', { cookie: 'jh_key=wrong' })).status, 401);
    const viaLink = await get(`/?k=${KEY}`, {});
    assert.equal(viaLink.status, 302);
    assert.match(viaLink.headers.get('set-cookie') ?? '', /jh_key=secret-key-123;.*HttpOnly/i);
    assert.equal(viaLink.headers.get('location'), '/');
  });

  it('locks a client out after repeated wrong keys, per client', async () => {
    const { get } = web();
    const from = (ip: string, k: string) => get(`/api/board?k=${k}`, { 'cf-connecting-ip': ip });
    for (let i = 0; i < 10; i++) assert.equal((await from('1.1.1.1', `guess${i}`)).status, 401);
    assert.equal((await from('1.1.1.1', KEY)).status, 429, 'even the right key waits out the lockout');
    assert.equal((await from('2.2.2.2', KEY)).status, 302, 'other clients are not affected');
  });

  it('serves the app manifest and icons without the key, nothing else', async () => {
    const { get } = web(undefined, { staticDir: new URL('../web/public', import.meta.url).pathname });
    // staticDir without index.html: static serving is off, so public paths fall through to 404, not 401.
    assert.notEqual((await get('/manifest.webmanifest', {})).status, 401);
    assert.notEqual((await get('/icon-192.png', {})).status, 401);
    assert.equal((await get('/index.html', {})).status, 401);
    assert.equal((await get('/api/board', {})).status, 401);
  });

  it('marks the cookie Secure only behind https', async () => {
    const { get } = web();
    assert.doesNotMatch((await get(`/?k=${KEY}`, {})).headers.get('set-cookie') ?? '', /Secure/);
    assert.match((await get(`/?k=${KEY}`, { 'x-forwarded-proto': 'https' })).headers.get('set-cookie') ?? '', /Secure/);
  });

  it('serves the board with sections, decisions and today in Kyiv', async () => {
    const { store, get } = web();
    seed(store, '1', { a: { role: 'fullstack', score: 80 } });
    seed(store, '2', { status: 'applied' });
    seed(store, '3', { status: 'filtered' });
    const res = await get('/api/board');
    assert.equal(res.status, 200);
    const board = (await res.json()) as { items: Array<{ key: string; section: string; decision: string }>; today: string; contact: unknown };
    assert.equal(board.today, '2026-10-02');
    assert.deepEqual(
      board.items.map((i) => [i.key, i.section, i.decision]),
      [
        ['djinni:1', 'fullstack', 'open'],
        ['djinni:2', 'backend', 'applied'],
      ],
    );
    assert.ok(board.contact);
  });

  it('records a decision and validates the body', async () => {
    const { store, post } = web();
    const key = seed(store, '1');
    const ok = await post(`/api/vacancies/${encodeURIComponent(key)}/decision`, { decision: 'applied' });
    assert.equal(ok.status, 200);
    assert.equal(store.get(key)?.status, 'applied');
    assert.equal((await post(`/api/vacancies/${encodeURIComponent(key)}/decision`, { decision: 'maybe' })).status, 400);
    assert.equal((await post('/api/vacancies/djinni%3Anope/decision', { decision: 'applied' })).status, 404);
  });

  it('starts a scan once and reports when one is already running', async () => {
    let running = false;
    let started = 0;
    const { post } = web(undefined, {
      scan: async () => {
        started++;
        running = true;
        return 'ok';
      },
      isScanning: () => running,
    });
    assert.deepEqual(await (await post('/api/scan', {})).json(), { started: true });
    assert.deepEqual(await (await post('/api/scan', {})).json(), { started: false });
    assert.equal(started, 1);
  });
});

describe('telegram announcement', () => {
  it('lists the count, sections and the best few, with the board link', () => {
    const v = (title: string, score: number, role: Assessment['role']) =>
      ({ title, company: 'Co', score, assessment: assessment({ role, score }) }) as StoredVacancy;
    const html = announcementHtml(
      [v('A', 70, 'backend'), v('B', 90, 'fullstack'), v('C', 65, 'fullstack'), v('D <x>', 80, 'frontend')],
      'http://192.168.1.63:8790/?k=abc',
    );
    assert.match(html, /4 новые вакансии<\/b> · Fullstack 2 · Backend 1 · Frontend 1/);
    assert.ok(html.indexOf('• B') < html.indexOf('• D') && html.indexOf('• D') < html.indexOf('• A'));
    assert.match(html, /D &lt;x&gt;/);
    assert.match(html, /…и ещё 1/);
    assert.match(html, /\?k=abc$/);
  });
});
