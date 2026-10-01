import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SqliteStore } from '../src/adapters/store/sqlite.ts';
import { addFromUrl, LlmUnavailableError, runScan, type PipelineDeps } from '../src/core/pipeline.ts';
import type { AssessInput, Llm, Notifier, StoredVacancy, VacancySource } from '../src/core/ports.ts';
import type { Assessment } from '../src/schemas/assessment.ts';
import { ProfileSchema } from '../src/schemas/profile.ts';
import type { Vacancy } from '../src/schemas/vacancy.ts';

const NOW = new Date('2026-10-01T10:00:00Z');

const vacancy = (id: string, over: Partial<Vacancy> = {}): Vacancy => ({
  key: `djinni:${id}`,
  source: 'djinni',
  externalId: id,
  url: `https://djinni.co/jobs/${id}-x/`,
  title: `Senior Node.js Developer ${id}`,
  company: null,
  description: 'Node.js',
  publishedAt: new Date('2026-09-30T10:00:00Z'),
  meta: {},
  ...over,
});

const profile = ProfileSchema.parse({
  candidate: { name: 'Іван', resumeFile: '/dev/null', englishLevel: 'A2' },
  filters: { englishMax: 'B1', titleStopWords: ['PHP'] },
  scoring: { notifyThreshold: 65, maxAssessPerRun: 10 },
  sources: { djinni: { feeds: [{}] }, dou: { feeds: [{}] } },
});

const assessment = (score: number, over: Partial<Assessment> = {}): Assessment => ({
  score,
  verdict: score >= 70 ? 'apply' : 'maybe',
  role: 'backend',
  aiFocus: 'some',
  englishRequired: 'unknown',
  pros: [],
  cons: [],
  summary: 'ok',
  ...over,
});

function setup(opts: {
  items: Vacancy[];
  enrich?: (v: Vacancy) => Vacancy;
  scores?: Record<string, Assessment | Error>;
  notifier?: Notifier;
}) {
  const store = new SqliteStore(':memory:');
  const source: VacancySource = {
    id: 'djinni',
    fetchLatest: async () => opts.items,
    matches: (url) => url.includes('djinni.co'),
    fetchOne: async (url) => vacancy(/jobs\/(\d+)/.exec(url)![1]!, { company: 'Linked Co' }),
    ...(opts.enrich ? { enrich: async (v: Vacancy) => opts.enrich!(v) } : {}),
  };
  const assessed: string[] = [];
  const llm: Llm = {
    assess: async ({ vacancy: v }: AssessInput) => {
      assessed.push(v.key);
      const result = opts.scores?.[v.key] ?? assessment(80);
      if (result instanceof Error) throw result;
      return result;
    },
    writeLetter: async ({ vacancy: v }) => `letter for ${v.key}`,
    chat: async () => ({ reply: '', letter: '' }),
  };
  const sent: StoredVacancy[] = [];
  const notifier: Notifier = opts.notifier ?? { announce: async (fresh) => (sent.push(...fresh), true) };
  const deps: PipelineDeps = { store, sources: [source], llm, notifier, profile, resume: 'cv', now: () => NOW };
  return { store, deps, assessed, sent };
}

describe('pipeline', () => {
  it('filters, assesses, writes letters and delivers', async () => {
    const { store, deps, assessed, sent } = setup({
      items: [vacancy('1'), vacancy('2', { title: 'PHP Developer' }), vacancy('3'), vacancy('4')],
      enrich: (v) => (v.key === 'djinni:4' ? { ...v, meta: { english: 'C1' } } : { ...v, company: `Co${v.externalId}` }),
      scores: { 'djinni:3': assessment(40) },
    });

    const report = await runScan(deps);
    assert.notEqual(report, 'locked');
    if (report === 'locked') return;

    assert.equal(report.inserted, 4);
    assert.equal(report.filtered, 2); // PHP by title, C1 after enrichment
    assert.deepEqual(assessed.sort(), ['djinni:1', 'djinni:3']);
    assert.equal(report.low, 1);
    assert.equal(report.ready, 1);
    assert.equal(report.notified, 1);
    assert.equal(sent[0]?.letter, 'letter for djinni:1');

    assert.equal(store.get('djinni:1')?.status, 'notified');
    assert.equal(store.get('djinni:1')?.company, 'Co1');
    assert.equal(store.get('djinni:2')?.reason, 'title:PHP');
    assert.equal(store.get('djinni:3')?.reason, 'score:40');
    assert.equal(store.get('djinni:4')?.reason, 'english:C1');
  });

  it('is idempotent: a second run does not re-assess', async () => {
    const { deps, assessed } = setup({ items: [vacancy('1')] });
    await runScan(deps);
    await runScan(deps);
    assert.deepEqual(assessed, ['djinni:1']);
  });

  it('rejects when Claude says the English is too high', async () => {
    const { store, deps } = setup({ items: [vacancy('1')], scores: { 'djinni:1': assessment(90, { englishRequired: 'B2' }) } });
    await runScan(deps);
    assert.equal(store.get('djinni:1')?.reason, 'english:B2');
  });

  it('stops the run when Claude is unavailable and leaves items queued', async () => {
    const { store, deps } = setup({
      items: [vacancy('1'), vacancy('2')],
      scores: { 'djinni:1': new LlmUnavailableError('usage limit'), 'djinni:2': new LlmUnavailableError('usage limit') },
    });
    const report = await runScan({ ...deps, llmConcurrency: 1 });
    assert.ok(report !== 'locked' && report.llmUnavailable);
    assert.equal(store.get('djinni:1')?.status, 'new');
    assert.equal(store.get('djinni:1')?.attempts, 0);
  });

  it('retries ordinary failures up to the attempt limit', async () => {
    const { store, deps, assessed } = setup({ items: [vacancy('1')], scores: { 'djinni:1': new Error('bad json') } });
    for (let i = 0; i < 5; i++) await runScan(deps);
    assert.equal(assessed.length, 3);
    assert.equal(store.get('djinni:1')?.status, 'error');
  });

  it('keeps cards queued when delivery is not configured', async () => {
    const { store, deps } = setup({ items: [vacancy('1')], notifier: { announce: async () => false } });
    await runScan(deps);
    assert.equal(store.get('djinni:1')?.status, 'ready');
  });

  it('announces a batch once, with the vacancies already in the queue, and rolls back on failure', async () => {
    const seen: string[][] = [];
    const { store, deps } = setup({
      items: [vacancy('1'), vacancy('2')],
      notifier: {
        announce: async (fresh) => {
          seen.push(store.listByStatus(['notified']).map((v) => v.key).sort());
          return fresh.length > 0;
        },
      },
    });
    await runScan(deps);
    assert.deepEqual(seen, [['djinni:1', 'djinni:2']]);

    const failing = setup({ items: [vacancy('3')], notifier: { announce: async () => Promise.reject(new Error('tg down')) } });
    await runScan(failing.deps);
    assert.equal(failing.store.get('djinni:3')?.status, 'ready');
  });

  it('adds a vacancy from a link regardless of filters, and reuses an existing assessment', async () => {
    const { store, deps, assessed } = setup({ items: [], scores: { 'djinni:77': assessment(30) } });
    const added = await addFromUrl(deps, 'https://djinni.co/jobs/77-x/');
    assert.equal(added.status, 'notified');
    assert.equal(added.reason, 'manual');
    assert.equal(added.company, 'Linked Co');
    assert.equal(added.letter, 'letter for djinni:77');
    await addFromUrl(deps, 'https://djinni.co/jobs/77-x/');
    assert.deepEqual(assessed, ['djinni:77']);
    await assert.rejects(addFromUrl(deps, 'https://example.com/job/1'), /Djinni и DOU/);
    assert.equal(store.get('djinni:77')?.score, 30);
  });

  it('marks cross-board duplicates of surfaced vacancies', async () => {
    const { store, deps } = setup({ items: [vacancy('1', { company: 'Acme', title: 'Node Dev' })] });
    await runScan(deps);
    store.insertIfAbsent({ ...vacancy('9', { company: 'ACME', title: 'Node dev' }), key: 'dou:9', source: 'dou' });
    const report = await runScan(deps);
    assert.ok(report !== 'locked');
    assert.equal(store.get('dou:9')?.status, 'duplicate');
  });

  it('promotes earlier low scores when the threshold is lowered, without re-assessing', async () => {
    const { store, deps, assessed } = setup({ items: [vacancy('1')], scores: { 'djinni:1': assessment(62) } });
    await runScan(deps);
    assert.equal(store.get('djinni:1')?.reason, 'score:62');

    const lowered = { ...profile, scoring: { ...profile.scoring, notifyThreshold: 60 } };
    await runScan({ ...deps, profile: lowered });
    assert.equal(store.get('djinni:1')?.status, 'notified');
    assert.equal(store.get('djinni:1')?.letter, 'letter for djinni:1');
    assert.deepEqual(assessed, ['djinni:1']);
  });

  it('drops queued vacancies that no longer pass changed filters, keeps manual picks, and says so', async () => {
    const notes: string[] = [];
    const notifier: Notifier = { announce: async () => true, refresh: async (note) => void notes.push(note) };
    const { store, deps } = setup({
      items: [vacancy('1', { meta: { english: 'B1' } }), vacancy('2')],
      scores: { 'djinni:2': assessment(80, { englishRequired: 'B1' }) },
      notifier,
    });
    await runScan(deps);
    await addFromUrl(deps, 'https://djinni.co/jobs/3-x/');
    store.update('djinni:3', { meta: { english: 'C1' } });
    assert.deepEqual(store.listByStatus(['notified']).map((v) => v.key).sort(), ['djinni:1', 'djinni:2', 'djinni:3']);

    const stricter = { ...profile, filters: { ...profile.filters, englishMax: 'A2' as const } };
    const report = await runScan({ ...deps, profile: stricter });
    assert.ok(report !== 'locked');
    assert.equal(report.unqueued, 2);
    assert.equal(store.get('djinni:1')?.reason, 'english:B1'); // stated on the page
    assert.equal(store.get('djinni:2')?.reason, 'english:B1'); // inferred by Claude
    assert.equal(store.get('djinni:3')?.status, 'notified'); // pasted by the user: untouched
    assert.match(notes[0] ?? '', /Убрал из очереди 2 вакансии.*английский B1/);
  });

  it('does not drop queued vacancies just because they got older', async () => {
    const { store, deps } = setup({ items: [vacancy('1')] });
    await runScan(deps);
    await runScan({ ...deps, now: () => new Date('2026-10-20T10:00:00Z') });
    assert.equal(store.get('djinni:1')?.status, 'notified');
  });

  it('refuses to run concurrently', async () => {
    const { store, deps } = setup({ items: [] });
    assert.equal(store.acquireLock('scan', 60_000), true);
    assert.equal(await runScan(deps), 'locked');
  });
});
