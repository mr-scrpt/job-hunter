import { cefrRank } from '../schemas/cefr.ts';
import type { Profile } from '../schemas/profile.ts';
import type { Vacancy } from '../schemas/vacancy.ts';
import { normalizeForMatch } from './text.ts';

type Filters = Profile['filters'];

const DAY_MS = 86_400_000;

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word match that also works for Cyrillic and tokens like ".NET" or "C#". */
export const containsWord = (text: string, word: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(word)}(?![\\p{L}\\p{N}])`, 'iu').test(text);

/**
 * Deterministic rules applied before spending LLM calls.
 * Returns the rejection reason, or null when the vacancy passes.
 * Safe to run before and after enrichment: unknown fields never reject.
 */
export function rejectReason(vacancy: Vacancy, filters: Filters, now: Date): string | null {
  const ageDays = (now.getTime() - vacancy.publishedAt.getTime()) / DAY_MS;
  if (ageDays > filters.maxAgeDays) return `old:${Math.floor(ageDays)}d`;

  const stopWord = filters.titleStopWords.find((w) => containsWord(vacancy.title, w));
  if (stopWord) return `title:${stopWord}`;

  const company = vacancy.company?.toLowerCase();
  const excluded = company && filters.excludeCompanies.find((c) => company.includes(c.toLowerCase()));
  if (excluded) return `company:${excluded}`;

  const { english, salaryMaxUsd, remote } = vacancy.meta;
  if (english && cefrRank(english) > cefrRank(filters.englishMax)) return `english:${english}`;
  if (filters.minSalaryUsd > 0 && salaryMaxUsd !== undefined && salaryMaxUsd < filters.minSalaryUsd)
    return `salary:${salaryMaxUsd}`;
  if (filters.remoteOnly && remote === false) return 'not-remote';

  return null;
}

/** Identity of a vacancy across boards; null until the company is known. */
export const matchKey = (vacancy: Vacancy): string | null =>
  vacancy.company ? `${normalizeForMatch(vacancy.company)}|${normalizeForMatch(vacancy.title)}` : null;
