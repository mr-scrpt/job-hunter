import type { Assessment } from '../schemas/assessment.ts';
import type { SourceId, Vacancy } from '../schemas/vacancy.ts';

export const STATUSES = [
  'new', // fetched, not processed yet
  'filtered', // dropped by deterministic rules (reason says which)
  'duplicate', // same company+title already seen on another board
  'low', // assessed, below threshold or hard mismatch
  'ready', // assessed + letter written, waiting to be delivered
  'notified', // card delivered to Telegram, waiting for the user
  'applied', // user confirmed the application was sent
  'skipped', // user dismissed it
  'error', // processing failed; retried until attempts run out
] as const;
export type Status = (typeof STATUSES)[number];

export interface StoredVacancy extends Vacancy {
  status: Status;
  reason: string | null;
  attempts: number;
  enriched: boolean;
  score: number | null;
  assessment: Assessment | null;
  letter: string | null;
  tgMessageId: number | null;
}

export interface VacancyPatch {
  status?: Status;
  reason?: string | null;
  attempts?: number;
  enriched?: boolean;
  company?: string | null;
  meta?: Vacancy['meta'];
  matchKey?: string | null;
  score?: number | null;
  assessment?: Assessment | null;
  letter?: string | null;
  tgMessageId?: number | null;
}

export interface Store {
  /** Returns true when the vacancy was not known before. */
  insertIfAbsent(vacancy: Vacancy): boolean;
  get(key: string): StoredVacancy | undefined;
  /** Newest first. */
  listByStatus(statuses: readonly Status[], limit?: number): StoredVacancy[];
  update(key: string, patch: VacancyPatch): void;
  /** Key of an already-processed vacancy from another board with the same match key. */
  findCrossPost(matchKey: string, source: SourceId): string | undefined;
  log(type: string, vacancyKey: string | null, detail?: unknown): void;
  getKv(name: string): string | undefined;
  setKv(name: string, value: string): void;
  /** Atomic lease; false when someone else holds a non-expired lock. */
  acquireLock(name: string, ttlMs: number): boolean;
  releaseLock(name: string): void;
  countByStatus(): Record<string, number>;
  countEventsSince(type: string, since: Date): number;
}

export interface VacancySource {
  readonly id: SourceId;
  fetchLatest(): Promise<Vacancy[]>;
  /** Optional detail-page pass for fields missing from the feed (company, salary, English). */
  enrich?(vacancy: Vacancy): Promise<Vacancy>;
}

export interface AssessInput {
  vacancy: Vacancy;
  resume: string;
  preferences: string;
  englishLevel: string;
  englishMax: string;
}

export interface LetterInput {
  vacancy: Vacancy;
  resume: string;
  candidateName: string;
  assessment: Assessment;
  previousLetter?: string;
  feedback?: string;
  /** Words that must never appear in the letter (employer names, industries the candidate hides). */
  forbiddenTerms?: string[];
}

export interface Llm {
  assess(input: AssessInput): Promise<Assessment>;
  writeLetter(input: LetterInput): Promise<string>;
}

export interface Notifier {
  /** Delivers a card; returns the message id, or undefined when delivery is not configured. */
  sendCard(vacancy: StoredVacancy): Promise<number | undefined>;
}
