import type { Assessment } from '../schemas/assessment.ts';
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
export function rejectReason(vacancy: Vacancy, filters: Filters, now: Date, { checkAge = true } = {}): string | null {
  if (checkAge) {
    const ageDays = (now.getTime() - vacancy.publishedAt.getTime()) / DAY_MS;
    if (ageDays > filters.maxAgeDays) return `old:${Math.floor(ageDays)}d`;
  }

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

/**
 * Re-check for vacancies Claude already rated (queued or archived as low): the same rules plus the
 * English level Claude inferred from the text. This is what makes a config change apply to the queue too.
 * Age is ignored by default — a vacancy doesn't stop fitting just because it waited in the queue.
 */
export function assessedRejectReason(
  vacancy: Vacancy & { assessment: Assessment | null },
  filters: Filters,
  now: Date,
  { checkAge = false } = {},
): string | null {
  const reason = rejectReason(vacancy, filters, now, { checkAge });
  if (reason) return reason;
  const required = vacancy.assessment?.englishRequired;
  if (required && required !== 'unknown' && cefrRank(required) > cefrRank(filters.englishMax)) return `english:${required}`;
  return null;
}

/** Human (Russian) wording for a rejection reason, for chat notes. */
export function describeReason(reason: string): string {
  const sep = reason.indexOf(':');
  const kind = sep < 0 ? reason : reason.slice(0, sep);
  const value = sep < 0 ? '' : reason.slice(sep + 1);
  switch (kind) {
    case 'english':
      return `английский ${value}`;
    case 'title':
      return `«${value}» в названии`;
    case 'company':
      return 'компания в исключениях';
    case 'salary':
      return `зарплата до $${value}`;
    case 'not-remote':
      return 'не удалёнка';
    case 'old':
      return 'старая вакансия';
    default:
      return reason;
  }
}

/** Identity of a vacancy across boards; null until the company is known. */
export const matchKey = (vacancy: Vacancy): string | null =>
  vacancy.company ? `${normalizeForMatch(vacancy.company)}|${normalizeForMatch(vacancy.title)}` : null;
