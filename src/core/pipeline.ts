import type { Assessment } from '../schemas/assessment.ts';
import { cefrRank } from '../schemas/cefr.ts';
import type { Profile } from '../schemas/profile.ts';
import { plural } from './deck.ts';
import { assessedRejectReason, describeReason, matchKey, rejectReason } from './filter.ts';
import { writeCheckedLetter } from './letter.ts';
import type { Llm, Notifier, Store, StoredVacancy, VacancySource } from './ports.ts';
import { mapPool } from './pool.ts';
import { truncate } from './text.ts';

/** Thrown by an Llm adapter when calls cannot succeed right now (usage limit, auth). */
export class LlmUnavailableError extends Error {
  override readonly name = 'LlmUnavailableError';
}

export interface PipelineDeps {
  store: Store;
  sources: VacancySource[];
  llm: Llm;
  notifier: Notifier;
  profile: Profile;
  resume: string;
  now?: () => Date;
  log?: (message: string) => void;
  /** Parallel Claude calls. */
  llmConcurrency?: number;
}

export interface ScanReport {
  fetched: number;
  inserted: number;
  filtered: number;
  duplicates: number;
  assessed: number;
  low: number;
  ready: number;
  notified: number;
  errors: number;
  deferred: number;
  /** Queued vacancies dropped because they no longer pass the (changed) filters. */
  unqueued: number;
  sourceErrors: string[];
  llmUnavailable: boolean;
}

const MAX_ATTEMPTS = 3;
const SCAN_LOCK_TTL_MS = 30 * 60_000;

export async function runScan(deps: PipelineDeps): Promise<ScanReport | 'locked'> {
  const { store } = deps;
  if (!store.acquireLock('scan', SCAN_LOCK_TTL_MS)) return 'locked';
  try {
    return await scan(deps);
  } finally {
    store.releaseLock('scan');
  }
}

async function scan(deps: PipelineDeps): Promise<ScanReport> {
  const { store, sources, profile } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const report: ScanReport = {
    fetched: 0,
    inserted: 0,
    filtered: 0,
    duplicates: 0,
    assessed: 0,
    low: 0,
    ready: 0,
    notified: 0,
    errors: 0,
    deferred: 0,
    unqueued: 0,
    sourceErrors: [],
    llmUnavailable: false,
  };

  // 1. Collect.
  for (const source of sources) {
    try {
      const items = await source.fetchLatest();
      report.fetched += items.length;
      for (const item of items) if (store.insertIfAbsent(item)) report.inserted++;
    } catch (error) {
      const message = `${source.id}: ${errorText(error)}`;
      report.sourceErrors.push(message);
      store.log('source_error', null, message);
      log(`source failed — ${message}`);
    }
  }

  // 2. Cheap gates: rules, enrichment, rules again, cross-board duplicates.
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const pending = store
    .listByStatus(['new', 'error'])
    .filter((v) => v.attempts < MAX_ATTEMPTS)
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

  const candidates: StoredVacancy[] = [];
  for (const stored of pending) {
    let vacancy: StoredVacancy = stored;
    let reason = rejectReason(vacancy, profile.filters, now());

    const source = sourceById.get(vacancy.source);
    if (!reason && !vacancy.enriched && source?.enrich) {
      try {
        const enriched = await source.enrich(vacancy);
        vacancy = { ...vacancy, ...enriched, enriched: true };
        store.update(vacancy.key, { enriched: true, company: vacancy.company, meta: vacancy.meta });
        reason = rejectReason(vacancy, profile.filters, now());
      } catch (error) {
        // Feed data is still usable; the LLM sees the full description anyway.
        store.log('enrich_error', vacancy.key, errorText(error));
      }
    }

    if (reason) {
      store.update(vacancy.key, { status: 'filtered', reason });
      report.filtered++;
      continue;
    }

    const key = matchKey(vacancy);
    store.update(vacancy.key, { matchKey: key });
    const original = key ? store.findCrossPost(key, vacancy.source) : undefined;
    if (original) {
      store.update(vacancy.key, { status: 'duplicate', reason: `same as ${original}` });
      report.duplicates++;
      continue;
    }
    candidates.push(vacancy);
  }

  // 2b. Filters may have changed since these were queued: drop what no longer fits. Manual picks stay.
  report.unqueued = await recheckQueue(deps, now(), log);

  // 3. LLM: assess, then write letters for the ones worth it.
  const budget = candidates.slice(0, profile.scoring.maxAssessPerRun);
  report.deferred = candidates.length - budget.length;
  let llmDown = false;

  // Vacancies rated earlier that clear a (since lowered) threshold only need a letter.
  const promotable = store
    .listByStatus(['low'])
    .filter((v) => v.assessment && v.reason?.startsWith('score:') && (v.score ?? 0) >= profile.scoring.notifyThreshold)
    .filter((v) => !assessedRejectReason(v, profile.filters, now(), { checkAge: true }));

  const tasks: Array<{ vacancy: StoredVacancy; run: () => Promise<void> }> = [
    ...promotable.map((v) => ({ vacancy: v, run: () => writeLetterFor(v, v.assessment!, deps, report) })),
    ...budget.map((v) => ({ vacancy: v, run: () => processWithLlm(v, deps, report) })),
  ];

  await mapPool(tasks, deps.llmConcurrency ?? 3, async ({ vacancy, run }) => {
    if (llmDown) return;
    try {
      await run();
    } catch (error) {
      if (error instanceof LlmUnavailableError) {
        llmDown = true;
        report.llmUnavailable = true;
        store.log('llm_unavailable', vacancy.key, error.message);
        log(`LLM unavailable, stopping this run — ${error.message}`);
        return;
      }
      report.errors++;
      store.update(vacancy.key, { status: 'error', reason: errorText(error), attempts: vacancy.attempts + 1 });
      store.log('process_error', vacancy.key, errorText(error));
      log(`failed ${vacancy.key} — ${errorText(error)}`);
    }
  });

  // 4. Deliver everything that is ready (including leftovers from earlier runs).
  report.notified = await deliverReady(store, deps.notifier, log);

  store.setKv('last_scan', JSON.stringify({ at: now().toISOString(), ...report }));
  return report;
}

async function recheckQueue(deps: PipelineDeps, now: Date, log: (m: string) => void): Promise<number> {
  const { store, profile } = deps;
  const dropped: Array<{ title: string; reason: string }> = [];
  for (const v of store.listByStatus(['ready', 'notified'])) {
    if (v.reason === 'manual') continue;
    const reason = assessedRejectReason(v, profile.filters, now);
    if (!reason) continue;
    store.update(v.key, { status: 'filtered', reason });
    store.log('unqueued', v.key, reason);
    dropped.push({ title: v.title, reason });
  }
  if (dropped.length && deps.notifier.refresh) {
    const list = dropped.map((d) => `${d.title} (${describeReason(d.reason)})`).join('; ');
    const word = plural(dropped.length, ['вакансию', 'вакансии', 'вакансий']);
    try {
      await deps.notifier.refresh(truncate(`Убрал из очереди ${dropped.length} ${word} по новым фильтрам: ${list}`, 400));
    } catch (error) {
      log(`queue refresh failed — ${errorText(error)}`);
    }
  }
  return dropped.length;
}

async function processWithLlm(vacancy: StoredVacancy, deps: PipelineDeps, report: ScanReport): Promise<void> {
  const { store, llm, profile, resume } = deps;
  const { candidate, filters, scoring } = profile;

  const assessment = await llm.assess({
    vacancy,
    resume,
    preferences: candidate.preferences,
    englishLevel: candidate.englishLevel,
    englishMax: filters.englishMax,
  });
  report.assessed++;
  store.log('assessed', vacancy.key, { score: assessment.score, verdict: assessment.verdict });

  const englishTooHigh =
    assessment.englishRequired !== 'unknown' && cefrRank(assessment.englishRequired) > cefrRank(filters.englishMax);
  const lowReason = englishTooHigh
    ? `english:${assessment.englishRequired}`
    : assessment.verdict === 'skip'
      ? 'verdict:skip'
      : assessment.score < scoring.notifyThreshold
        ? `score:${assessment.score}`
        : null;

  if (lowReason) {
    store.update(vacancy.key, { status: 'low', reason: lowReason, score: assessment.score, assessment });
    report.low++;
    return;
  }

  await writeLetterFor(vacancy, assessment, deps, report);
}

async function writeLetterFor(vacancy: StoredVacancy, assessment: Assessment, deps: PipelineDeps, report: ScanReport): Promise<void> {
  const { store, llm, profile, resume } = deps;
  const letter = await writeCheckedLetter(
    llm,
    { vacancy, resume, candidateName: profile.candidate.name, assessment },
    profile.candidate.neverMention,
  );
  store.update(vacancy.key, { status: 'ready', reason: null, score: assessment.score, assessment, letter });
  report.ready++;
}

/**
 * Moves every `ready` vacancy into the review queue (`notified`) and tells the user once for the whole batch.
 * If the notifier is not configured or fails, they go back to `ready` and are retried next run.
 */
export async function deliverReady(store: Store, notifier: Notifier, log: (m: string) => void = () => {}): Promise<number> {
  const ready = store.listByStatus(['ready']);
  if (ready.length === 0) return 0;
  // Flip first: the notifier renders the queue, which must already contain the new ones.
  for (const vacancy of ready) store.update(vacancy.key, { status: 'notified' });
  let delivered = false;
  try {
    delivered = await notifier.announce(ready);
  } catch (error) {
    store.log('notify_error', null, errorText(error));
    log(`notify failed — ${errorText(error)}`);
  }
  if (!delivered) {
    for (const vacancy of ready) store.update(vacancy.key, { status: 'ready' });
    return 0;
  }
  for (const vacancy of ready) store.log('notified', vacancy.key);
  return ready.length;
}

/**
 * A vacancy the user pasted a link to: fetched from its page, assessed and given a letter regardless of
 * filters and threshold (the user chose it), then put into the review queue.
 */
export async function addFromUrl(deps: PipelineDeps, url: string): Promise<StoredVacancy> {
  const { store, sources, llm, profile, resume } = deps;
  const source = sources.find((s) => s.matches(url));
  if (!source) throw new Error('Понимаю только ссылки на вакансии Djinni и DOU.');

  const fetched = await source.fetchOne(url);
  store.insertIfAbsent(fetched);
  const known = store.get(fetched.key);
  if (!known) throw new Error(`vacancy ${fetched.key} vanished from the store`);
  const vacancy: StoredVacancy = known.enriched ? known : { ...known, company: fetched.company ?? known.company, meta: { ...known.meta, ...fetched.meta } };
  if (!known.enriched) store.update(vacancy.key, { enriched: true, company: vacancy.company, meta: vacancy.meta });

  const assessment =
    vacancy.assessment ??
    (await llm.assess({
      vacancy,
      resume,
      preferences: profile.candidate.preferences,
      englishLevel: profile.candidate.englishLevel,
      englishMax: profile.filters.englishMax,
    }));
  const letter =
    vacancy.letter ??
    (await writeCheckedLetter(llm, { vacancy, resume, candidateName: profile.candidate.name, assessment }, profile.candidate.neverMention));

  store.update(vacancy.key, { status: 'notified', reason: 'manual', score: assessment.score, assessment, letter });
  store.log('manual_add', vacancy.key, { url });
  return store.get(vacancy.key) as StoredVacancy;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500);
