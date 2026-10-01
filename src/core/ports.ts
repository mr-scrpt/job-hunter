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
  addChatTurn(vacancyKey: string, turn: ChatTurn): void;
  /** Last `limit` turns for a vacancy, oldest first. */
  recentChat(vacancyKey: string, limit: number): ChatTurn[];
}

export interface VacancySource {
  readonly id: SourceId;
  fetchLatest(): Promise<Vacancy[]>;
  /** Optional detail-page pass for fields missing from the feed (company, salary, English). */
  enrich?(vacancy: Vacancy): Promise<Vacancy>;
  /** Whether a pasted link belongs to this board. */
  matches(url: string): boolean;
  /** Reads one vacancy straight from its page. */
  fetchOne(url: string): Promise<Vacancy>;
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

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatInput {
  vacancy: Vacancy;
  resume: string;
  candidateName: string;
  assessment: Assessment;
  letter: string;
  /** Earlier turns about this vacancy, oldest first. */
  history: ChatTurn[];
  message: string;
  forbiddenTerms?: string[];
}

export interface ChatReply {
  /** Short answer to the user (Russian). */
  reply: string;
  /** Full new letter, or empty when the letter stays as is. */
  letter: string;
}

export interface Llm {
  assess(input: AssessInput): Promise<Assessment>;
  writeLetter(input: LetterInput): Promise<string>;
  /** Free-form conversation about one vacancy: edits the letter or answers a question. */
  chat(input: ChatInput): Promise<ChatReply>;
}

export interface Notifier {
  /**
   * Tells the user that `fresh` vacancies are ready for review (one message for the whole batch).
   * Returns false when delivery is not configured, so they stay queued as `ready`.
   */
  announce(fresh: StoredVacancy[], note?: string): Promise<boolean>;
  /** Re-renders the review queue after it changed without user action, with a one-line note. */
  refresh?(note: string): Promise<void>;
}
