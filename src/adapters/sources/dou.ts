import { parseEnglishRequirement } from '../../core/english.ts';
import type { VacancySource } from '../../core/ports.ts';
import { decodeEntities, htmlToText } from '../../core/text.ts';
import type { FeedSourceConfig } from '../../schemas/profile.ts';
import { vacancyKey, type Vacancy, type VacancyMeta } from '../../schemas/vacancy.ts';
import { buildUrl, type HttpClient } from './http.ts';
import { parseRss, type RssItem } from './rss.ts';

const FEED_URL = 'https://jobs.dou.ua/vacancies/feeds/';

/**
 * DOU RSS carries everything needed: "Title в Company, $min–max, City, віддалено" plus the full description.
 * DOU forbids automated applications, so this source is read-only by design.
 */
export class DouSource implements VacancySource {
  readonly id = 'dou' as const;
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
        const vacancy = douItemToVacancy(item);
        if (vacancy) byKey.set(vacancy.key, vacancy);
      }
    }
    return [...byKey.values()];
  }
}

const REMOTE = /віддалено|remote/i;
const SALARY = /^(?:(?:від|from)\s*)?(?:(?:до|up to)\s*)?\$\s?[\d\s]+(?:\s*[–-]\s*[\d\s]+)?$/i;

export function parseDouTitle(raw: string): { title: string; company: string | null; meta: VacancyMeta } {
  const text = decodeEntities(raw).replace(/\s+/g, ' ').trim();
  const sep = text.lastIndexOf(' в ');
  if (sep < 0) return { title: text, company: null, meta: {} };

  const title = text.slice(0, sep).trim();
  const [company = '', ...rest] = text.slice(sep + 3).split(',').map((part) => part.trim());

  const meta: VacancyMeta = {};
  const locations: string[] = [];
  for (const part of rest) {
    if (SALARY.test(part)) Object.assign(meta, parseSalary(part));
    else if (REMOTE.test(part)) meta.remote = true;
    else if (part) locations.push(part);
  }
  if (locations.length) meta.locations = locations;
  if (meta.remote === undefined && locations.length) meta.remote = false;
  return { title, company: company || null, meta };
}

function parseSalary(text: string): Pick<VacancyMeta, 'salaryMinUsd' | 'salaryMaxUsd'> {
  const numbers = [...text.matchAll(/\d[\d\s]*/g)].map((m) => Number(m[0].replace(/\s/g, '')));
  const [first, second] = numbers;
  if (first === undefined) return {};
  if (second !== undefined) return { salaryMinUsd: first, salaryMaxUsd: second };
  if (/до|up to/i.test(text)) return { salaryMaxUsd: first };
  if (/від|from/i.test(text)) return { salaryMinUsd: first };
  return { salaryMinUsd: first, salaryMaxUsd: first };
}

export function douItemToVacancy(item: RssItem): Vacancy | undefined {
  const id = /\/vacancies\/(\d+)/.exec(item.link)?.[1];
  const publishedAt = new Date(item.pubDate);
  if (!id || Number.isNaN(publishedAt.getTime())) return undefined;

  const url = item.link.split('?')[0] ?? item.link;
  const { title, company, meta } = parseDouTitle(item.title);
  const description = htmlToText(item.description);
  const english = parseEnglishRequirement(description);
  if (english) meta.english = english;

  return {
    key: vacancyKey('dou', id),
    source: 'dou',
    externalId: id,
    url,
    title,
    company,
    description,
    publishedAt,
    meta,
  };
}
