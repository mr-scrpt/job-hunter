import { parseEnglishRequirement } from '../../core/english.ts';
import type { VacancySource } from '../../core/ports.ts';
import { decodeEntities, htmlToText } from '../../core/text.ts';
import { parseCefr } from '../../schemas/cefr.ts';
import type { FeedSourceConfig } from '../../schemas/profile.ts';
import { vacancyKey, type Vacancy, type VacancyMeta } from '../../schemas/vacancy.ts';
import { buildUrl, type HttpClient } from './http.ts';
import { parseRss, type RssItem } from './rss.ts';

const FEED_URL = 'https://djinni.co/jobs/rss/';

/** Djinni RSS gives title/description/date only; company, salary and English live on the job page. */
export class DjinniSource implements VacancySource {
  readonly id = 'djinni' as const;
  readonly #config: FeedSourceConfig;
  readonly #http: HttpClient;

  constructor(config: FeedSourceConfig, http: HttpClient) {
    this.#config = config;
    this.#http = http;
  }

  async fetchLatest(): Promise<Vacancy[]> {
    const byKey = new Map<string, Vacancy>();
    for (const feed of this.#config.feeds) {
      const xml = await this.#http.getText(buildUrl(FEED_URL, this.#config.common, feed));
      for (const item of parseRss(xml)) {
        const vacancy = djinniItemToVacancy(item);
        if (vacancy) byKey.set(vacancy.key, vacancy);
      }
    }
    return [...byKey.values()];
  }

  async enrich(vacancy: Vacancy): Promise<Vacancy> {
    const html = await this.#http.getText(vacancy.url);
    const page = parseDjinniJobPage(html);
    return { ...vacancy, company: page.company ?? vacancy.company, meta: { ...vacancy.meta, ...page.meta } };
  }
}

export function djinniItemToVacancy(item: RssItem): Vacancy | undefined {
  const url = item.link || item.guid;
  const id = /\/jobs\/(\d+)/.exec(url)?.[1];
  const publishedAt = new Date(item.pubDate);
  if (!id || Number.isNaN(publishedAt.getTime())) return undefined;

  const description = htmlToText(item.description);
  const english = parseEnglishRequirement(description);
  return {
    key: vacancyKey('djinni', id),
    source: 'djinni',
    externalId: id,
    url,
    title: decodeEntities(item.title).trim(),
    company: null,
    description,
    publishedAt,
    meta: english ? { english } : {},
  };
}

interface JobPosting {
  hiringOrganization?: { name?: string };
  baseSalary?: { currency?: string; value?: { minValue?: number; maxValue?: number; value?: number; unitText?: string } };
  experienceRequirements?: { monthsOfExperience?: number };
  jobLocationType?: string;
  industry?: string;
}

export function parseDjinniJobPage(html: string): { company: string | null; meta: VacancyMeta } {
  const meta: VacancyMeta = {};
  let company: string | null = null;

  const posting = findJobPosting(html);
  if (posting) {
    company = posting.hiringOrganization?.name?.trim() || null;
    const salary = posting.baseSalary;
    if (salary?.currency === 'USD' && (salary.value?.unitText ?? 'MONTH') === 'MONTH') {
      const min = salary.value?.minValue ?? salary.value?.value;
      const max = salary.value?.maxValue ?? salary.value?.value;
      if (min) meta.salaryMinUsd = min;
      if (max) meta.salaryMaxUsd = max;
    }
    const months = posting.experienceRequirements?.monthsOfExperience;
    if (months !== undefined) meta.experienceYears = Math.round(months / 12);
    if (posting.jobLocationType === 'TELECOMMUTE') meta.remote = true;
    if (posting.industry && posting.industry !== 'other') meta.domain = posting.industry;
  }

  // Sidebar: "Англійська B2 – Вище середнього" (or "English B2 – Upper-Intermediate").
  const englishMatch = /(?:Англійська|English)\s*(?:<[^>]*>\s*)*([ABCАВС][12])\s*[–-]/.exec(html);
  const english = englishMatch?.[1] ? parseCefr(englishMatch[1]) : undefined;
  if (english) meta.english = english;

  const applicants = /(\d[\d\s]*)\s+(?:відгук|applicant)/i.exec(html)?.[1];
  if (applicants) meta.applicants = Number(applicants.replace(/\s/g, ''));

  if (/Тільки віддалено|Only remote|Full Remote/i.test(html)) meta.remote = true;

  return { company, meta };
}

function findJobPosting(html: string): JobPosting | undefined {
  for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const data = JSON.parse(json ?? '') as { '@type'?: string };
      if (data['@type'] === 'JobPosting') return data as JobPosting;
    } catch {
      // Malformed block — keep looking.
    }
  }
  return undefined;
}
