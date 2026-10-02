import { parseEnglishRequirement } from '../../core/english.ts';
import type { VacancySource } from '../../core/ports.ts';
import { decodeEntities, htmlToText } from '../../core/text.ts';
import type { FeedSourceConfig } from '../../schemas/profile.ts';
import { vacancyKey, type Vacancy, type VacancyMeta } from '../../schemas/vacancy.ts';
import { buildUrl, type HttpClient } from './http.ts';

const API = 'https://api.rabota.ua';

/** Search hit from `GET /vacancy/search`. */
export interface RobotaSearchDoc {
  id: number;
  name: string;
  companyName?: string | null;
  notebookId?: number;
  date: string;
  cityName?: string | null;
  salary?: number | null;
  salaryFrom?: number | null;
  salaryTo?: number | null;
  shortDescription?: string | null;
}

/** Full vacancy from `GET /vacancy?id=`. */
export interface RobotaVacancy extends RobotaSearchDoc {
  description?: string | null;
  scheduleId?: number;
  languages?: unknown[];
  clusters?: Array<{ name: string; groups: Array<{ name: string }> }>;
}

// Schedule ids from /dictionary/schedule: 3 = віддалена робота, 8 = гібридна, 9 = в офісі.
const SCHEDULE_REMOTE = 3;
const ANONYMOUS = /аноним|анонім|anonymous|конфіденц|конфиденц/i;

/**
 * Robota.ua through its public JSON API (the site itself is behind a bot wall, the API is not).
 * Search gives title/company/date/snippet; `enrich` reads the full vacancy (description, remote, English).
 */
export class RobotaSource implements VacancySource {
  readonly id = 'robota' as const;
  readonly #config: FeedSourceConfig;
  readonly #http: HttpClient;

  constructor(config: FeedSourceConfig, http: HttpClient) {
    this.#config = config;
    this.#http = http;
  }

  async fetchLatest(): Promise<Vacancy[]> {
    const byKey = new Map<string, Vacancy>();
    for (const feed of this.#config.feeds) {
      const body = await this.#http.getText(buildUrl(`${API}/vacancy/search`, this.#config.common, feed));
      const { documents = [] } = JSON.parse(body) as { documents?: RobotaSearchDoc[] };
      for (const doc of documents) {
        const vacancy = robotaDocToVacancy(doc);
        if (vacancy) byKey.set(vacancy.key, vacancy);
      }
    }
    return [...byKey.values()];
  }

  async enrich(vacancy: Vacancy): Promise<Vacancy> {
    const full = await this.#fetchVacancy(vacancy.externalId);
    const detailed = robotaVacancyToVacancy(full);
    if (!detailed) return vacancy;
    return { ...vacancy, ...detailed, meta: { ...vacancy.meta, ...detailed.meta } };
  }

  matches(url: string): boolean {
    return ROBOTA_JOB.test(url);
  }

  async fetchOne(url: string): Promise<Vacancy> {
    const id = ROBOTA_JOB.exec(url)?.[1];
    if (!id) throw new Error(`not a Robota.ua vacancy URL: ${url}`);
    const vacancy = robotaVacancyToVacancy(await this.#fetchVacancy(id));
    if (!vacancy) throw new Error('could not read the vacancy');
    return vacancy;
  }

  async #fetchVacancy(id: string): Promise<RobotaVacancy> {
    return JSON.parse(await this.#http.getText(`${API}/vacancy?id=${encodeURIComponent(id)}`)) as RobotaVacancy;
  }
}

const ROBOTA_JOB = /(?:robota|rabota)\.ua\/(?:[a-z]{2}\/)?(?:company\d+\/)?vacancy(\d+)/i;

/** Public page of a vacancy. */
export const robotaUrl = (id: number | string, notebookId?: number): string =>
  notebookId ? `https://robota.ua/company${notebookId}/vacancy${id}` : `https://robota.ua/vacancy${id}`;

/** The API returns Kyiv wall-clock time without an offset ("2026-10-01T04:01:00.46"). */
export function parseKyivTime(local: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(local);
  if (!m) return new Date(Number.NaN);
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  // Offset of Kyiv at that moment (+2 in winter, +3 in summer), read from the tz database.
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(asUtc))
    .find((p) => p.type === 'timeZoneName')?.value;
  const offsetHours = Number(/GMT([+-]\d+)/.exec(name ?? '')?.[1] ?? 2);
  return new Date(asUtc - offsetHours * 3_600_000);
}

const company = (name?: string | null): string | null => {
  const clean = decodeEntities(name ?? '').trim();
  return clean && !ANONYMOUS.test(clean) ? clean : null;
};

function salaryText(v: RobotaSearchDoc): string | undefined {
  const fmt = (n: number) => n.toLocaleString('uk-UA').replace(/\u00a0/g, ' ');
  const { salaryFrom: from, salaryTo: to, salary } = v;
  if (from && to) return `${fmt(from)}–${fmt(to)} грн`;
  if (from) return `від ${fmt(from)} грн`;
  if (to) return `до ${fmt(to)} грн`;
  if (salary) return `${fmt(salary)} грн`;
  return undefined;
}

function baseMeta(v: RobotaSearchDoc): VacancyMeta {
  const meta: VacancyMeta = {};
  const salary = salaryText(v);
  if (salary) meta.salaryText = salary;
  if (v.cityName) meta.locations = [v.cityName];
  return meta;
}

export function robotaDocToVacancy(doc: RobotaSearchDoc): Vacancy | undefined {
  const publishedAt = parseKyivTime(doc.date);
  if (!doc.id || !doc.name || Number.isNaN(publishedAt.getTime())) return undefined;
  const description = htmlToText(doc.shortDescription ?? '');
  const meta = baseMeta(doc);
  const english = parseEnglishRequirement(description);
  if (english) meta.english = english;
  return {
    key: vacancyKey('robota', String(doc.id)),
    source: 'robota',
    externalId: String(doc.id),
    url: robotaUrl(doc.id, doc.notebookId),
    title: decodeEntities(doc.name).trim(),
    company: company(doc.companyName),
    description,
    publishedAt,
    meta,
  };
}

export function robotaVacancyToVacancy(v: RobotaVacancy): Vacancy | undefined {
  const base = robotaDocToVacancy(v);
  if (!base) return undefined;
  const description = htmlToText(v.description ?? '') || base.description;
  const meta: VacancyMeta = { ...baseMeta(v) };

  const groups = (v.clusters ?? []).flatMap((c) => c.groups.map((g) => g.name));
  const remoteTagged = groups.some((g) => /удал[её]нн|віддален|remote/i.test(g));
  meta.remote = v.scheduleId === SCHEDULE_REMOTE || remoteTagged;

  // Structured languages (when present) beat a guess from the text.
  const languages = (v.languages ?? []).map((l) => JSON.stringify(l)).join(' ');
  const english =
    (/англ|english/i.test(languages) ? parseEnglishRequirement(`English ${languages}`) : undefined) ??
    parseEnglishRequirement(description);
  if (english) meta.english = english;

  return { ...base, description, meta };
}
