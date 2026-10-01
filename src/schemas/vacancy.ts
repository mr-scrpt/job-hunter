import type { Cefr } from './cefr.ts';

export type SourceId = 'djinni' | 'dou';

export interface VacancyMeta {
  salaryMinUsd?: number;
  salaryMaxUsd?: number;
  /** English level explicitly required by the posting. */
  english?: Cefr;
  remote?: boolean;
  locations?: string[];
  experienceYears?: number;
  applicants?: number;
  domain?: string;
}

export interface Vacancy {
  /** `${source}:${externalId}` — primary key everywhere. */
  key: string;
  source: SourceId;
  externalId: string;
  url: string;
  title: string;
  company: string | null;
  /** Plain text, already stripped of HTML. */
  description: string;
  publishedAt: Date;
  meta: VacancyMeta;
}

export const vacancyKey = (source: SourceId, externalId: string): string => `${source}:${externalId}`;
