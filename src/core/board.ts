import type { Cefr } from '../schemas/cefr.ts';
import type { SourceId } from '../schemas/vacancy.ts';
import { effectiveEnglish, englishStretch } from './filter.ts';
import { detectLanguage, type TextLanguage } from './language.ts';
import { notesIn, type LetterNote } from './letter-notes.ts';
import type { StoredVacancy } from './ports.ts';

/**
 * The web board: every vacancy the user has to look at or already decided on, shaped for the UI.
 * Pure: the server builds it from the store, the client only filters and groups it.
 */

export const SECTIONS = ['fullstack', 'backend', 'frontend', 'other'] as const;
export type Section = (typeof SECTIONS)[number];

/** What the user decided. `open` = still waiting for a decision. */
export type Decision = 'open' | 'applied' | 'skipped';

export interface BoardItem {
  key: string;
  source: SourceId;
  url: string;
  title: string;
  company: string | null;
  publishedAt: string;
  /** Kyiv calendar day of publication, YYYY-MM-DD. */
  day: string;
  decision: Decision;
  score: number;
  section: Section;
  aiFocus: 'none' | 'some' | 'core';
  /** English the vacancy needs (stricter of page and Claude), if known. */
  english: Cefr | null;
  /** Needs more English than the candidate has: listed after the comfortable ones. */
  stretch: boolean;
  /** Language of the posting itself. */
  language: TextLanguage;
  /** Large parts in both Cyrillic and English. */
  languageMixed: boolean;
  /** Written in English but states no English level: worth asking what is really needed. */
  englishUnclear: boolean;
  /** English notes currently in the letter (toggled by the candidate). */
  notes: LetterNote[];
  salary: string | null;
  remote: boolean | null;
  applicants: number | null;
  summary: string;
  pros: string[];
  cons: string[];
  letter: string | null;
  /** Added by the user from a link (not found by the scan). */
  manual: boolean;
}

export interface Board {
  items: BoardItem[];
  /** Kyiv calendar day of "now", YYYY-MM-DD. */
  today: string;
  englishLevel: Cefr;
  contact: { fullName: string; email?: string; phone?: string } | null;
  lastScanAt: string | null;
  scanIntervalMinutes: number;
  scanning: boolean;
}

const DECISION: Partial<Record<StoredVacancy['status'], Decision>> = {
  ready: 'open',
  notified: 'open',
  applied: 'applied',
  skipped: 'skipped',
};

/** Statuses that appear on the board. */
export const BOARD_STATUSES = Object.keys(DECISION) as StoredVacancy['status'][];

const KYIV_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' });

/** YYYY-MM-DD of the given moment in Kyiv. */
export const kyivDay = (date: Date): string => KYIV_DAY.format(date);

function salaryLabel({ salaryMinUsd: min, salaryMaxUsd: max, salaryText }: StoredVacancy['meta']): string | null {
  if (min !== undefined && max !== undefined) return min === max ? `$${min}` : `$${min}–${max}`;
  if (max !== undefined) return `до $${max}`;
  if (min !== undefined) return `от $${min}`;
  return salaryText ?? null;
}

export function toBoardItem(v: StoredVacancy, englishLevel: Cefr): BoardItem | undefined {
  const decision = DECISION[v.status];
  if (!decision) return undefined;
  const a = v.assessment;
  const english = effectiveEnglish(v) ?? null;
  const lang = detectLanguage(`${v.title}\n${v.description}`);
  return {
    key: v.key,
    source: v.source,
    url: v.url,
    title: v.title,
    company: v.company,
    publishedAt: v.publishedAt.toISOString(),
    day: kyivDay(v.publishedAt),
    decision,
    score: v.score ?? a?.score ?? 0,
    section: a?.role ?? 'other',
    aiFocus: a?.aiFocus ?? 'none',
    english,
    stretch: Boolean(englishStretch(v, englishLevel)),
    language: lang.main,
    languageMixed: lang.mixed,
    englishUnclear: (lang.main === 'en' || lang.mixed) && english === null,
    notes: v.letter ? notesIn(v.letter) : [],
    salary: salaryLabel(v.meta),
    remote: v.meta.remote ?? null,
    applicants: v.meta.applicants ?? null,
    summary: a?.summary ?? '',
    pros: a?.pros ?? [],
    cons: a?.cons ?? [],
    letter: v.letter,
    manual: v.reason === 'manual',
  };
}

/** Comfortable English before stretch, then best score, then newest. */
export const compareItems = (a: BoardItem, b: BoardItem): number =>
  Number(a.stretch) - Number(b.stretch) || b.score - a.score || b.publishedAt.localeCompare(a.publishedAt);

export function buildBoardItems(vacancies: StoredVacancy[], englishLevel: Cefr): BoardItem[] {
  return vacancies
    .map((v) => toBoardItem(v, englishLevel))
    .filter((i): i is BoardItem => Boolean(i))
    .sort(compareItems);
}

/** One-line summary of a batch for the Telegram notification, e.g. "Fullstack 2 · Backend 1". */
export function sectionBreakdown(items: Array<Pick<BoardItem, 'section'>>): string {
  const label: Record<Section, string> = { fullstack: 'Fullstack', backend: 'Backend', frontend: 'Frontend', other: 'Другое' };
  return SECTIONS.map((s) => [label[s], items.filter((i) => i.section === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${name} ${n}`)
    .join(' · ');
}
