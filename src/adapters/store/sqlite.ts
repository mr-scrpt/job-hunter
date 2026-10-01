import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { ChatTurn, Status, Store, StoredVacancy, VacancyPatch } from '../../core/ports.ts';
import { AssessmentSchema } from '../../schemas/assessment.ts';
import type { SourceId, Vacancy } from '../../schemas/vacancy.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vacancies (
  key            TEXT PRIMARY KEY,
  source         TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  url            TEXT NOT NULL,
  title          TEXT NOT NULL,
  company        TEXT,
  description    TEXT NOT NULL,
  published_at   INTEGER NOT NULL,
  meta           TEXT NOT NULL DEFAULT '{}',
  enriched       INTEGER NOT NULL DEFAULT 0,
  match_key      TEXT,
  status         TEXT NOT NULL DEFAULT 'new',
  reason         TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  score          INTEGER,
  assessment     TEXT,
  letter         TEXT,
  tg_message_id  INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS vacancies_status ON vacancies(status, published_at);
CREATE INDEX IF NOT EXISTS vacancies_match ON vacancies(match_key);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  type         TEXT NOT NULL,
  vacancy_key  TEXT,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS events_type_at ON events(type, at);

CREATE TABLE IF NOT EXISTS chat (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  vacancy_key  TEXT NOT NULL,
  role         TEXT NOT NULL,
  text         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_vacancy ON chat(vacancy_key, id);

CREATE TABLE IF NOT EXISTS kv (
  name   TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

// Statuses that mean "this vacancy already went (or is going) to the user".
const SURFACED: readonly Status[] = ['ready', 'notified', 'applied', 'skipped', 'low'];

const COLUMN: Record<keyof VacancyPatch, string> = {
  status: 'status',
  reason: 'reason',
  attempts: 'attempts',
  enriched: 'enriched',
  company: 'company',
  meta: 'meta',
  matchKey: 'match_key',
  score: 'score',
  assessment: 'assessment',
  letter: 'letter',
};

type Row = Record<string, SQLInputValue>;

export class SqliteStore implements Store {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  insertIfAbsent(v: Vacancy): boolean {
    const now = Date.now();
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO vacancies
          (key, source, external_id, url, title, company, description, published_at, meta, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.key, v.source, v.externalId, v.url, v.title, v.company, v.description, v.publishedAt.getTime(), JSON.stringify(v.meta), now, now);
    return result.changes > 0;
  }

  get(key: string): StoredVacancy | undefined {
    const row = this.#db.prepare('SELECT * FROM vacancies WHERE key = ?').get(key) as Row | undefined;
    return row ? toStored(row) : undefined;
  }

  listByStatus(statuses: readonly Status[], limit = 1000): StoredVacancy[] {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => '?').join(', ');
    const rows = this.#db
      .prepare(`SELECT * FROM vacancies WHERE status IN (${marks}) ORDER BY published_at DESC LIMIT ?`)
      .all(...statuses, limit) as Row[];
    return rows.map(toStored);
  }

  update(key: string, patch: VacancyPatch): void {
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [field, value] of Object.entries(patch) as [keyof VacancyPatch, unknown][]) {
      if (value === undefined) continue;
      sets.push(`${COLUMN[field]} = ?`);
      values.push(toColumnValue(field, value));
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(Date.now(), key);
    this.#db.prepare(`UPDATE vacancies SET ${sets.join(', ')} WHERE key = ?`).run(...values);
  }

  findCrossPost(matchKey: string, source: SourceId): string | undefined {
    const marks = SURFACED.map(() => '?').join(', ');
    const row = this.#db
      .prepare(`SELECT key FROM vacancies WHERE match_key = ? AND source != ? AND status IN (${marks}) LIMIT 1`)
      .get(matchKey, source, ...SURFACED) as { key: string } | undefined;
    return row?.key;
  }

  log(type: string, vacancyKey: string | null, detail?: unknown): void {
    const text = detail === undefined ? null : typeof detail === 'string' ? detail : JSON.stringify(detail);
    this.#db.prepare('INSERT INTO events (at, type, vacancy_key, detail) VALUES (?, ?, ?, ?)').run(Date.now(), type, vacancyKey, text);
  }

  getKv(name: string): string | undefined {
    const row = this.#db.prepare('SELECT value FROM kv WHERE name = ?').get(name) as { value: string } | undefined;
    return row?.value;
  }

  setKv(name: string, value: string): void {
    this.#db.prepare('INSERT INTO kv (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, value);
  }

  acquireLock(name: string, ttlMs: number): boolean {
    const now = Date.now();
    const result = this.#db
      .prepare(
        `INSERT INTO kv (name, value) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value WHERE CAST(kv.value AS INTEGER) < ?`,
      )
      .run(`lock:${name}`, String(now + ttlMs), now);
    return result.changes > 0;
  }

  releaseLock(name: string): void {
    this.#db.prepare('DELETE FROM kv WHERE name = ?').run(`lock:${name}`);
  }

  countByStatus(): Record<string, number> {
    const rows = this.#db.prepare('SELECT status, COUNT(*) AS n FROM vacancies GROUP BY status').all() as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  addChatTurn(vacancyKey: string, turn: ChatTurn): void {
    this.#db.prepare('INSERT INTO chat (at, vacancy_key, role, text) VALUES (?, ?, ?, ?)').run(Date.now(), vacancyKey, turn.role, turn.text);
  }

  recentChat(vacancyKey: string, limit: number): ChatTurn[] {
    const rows = this.#db
      .prepare('SELECT role, text FROM chat WHERE vacancy_key = ? ORDER BY id DESC LIMIT ?')
      .all(vacancyKey, limit) as { role: ChatTurn['role']; text: string }[];
    return rows.reverse();
  }

  countEventsSince(type: string, since: Date): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ? AND at >= ?').get(type, since.getTime()) as { n: number };
    return row.n;
  }
}

function toColumnValue(field: keyof VacancyPatch, value: unknown): SQLInputValue {
  if (value === null) return null;
  switch (field) {
    case 'meta':
    case 'assessment':
      return JSON.stringify(value);
    case 'enriched':
      return value ? 1 : 0;
    default:
      return value as SQLInputValue;
  }
}

function toStored(row: Row): StoredVacancy {
  const assessment = row.assessment ? AssessmentSchema.safeParse(JSON.parse(String(row.assessment))) : undefined;
  return {
    key: String(row.key),
    source: row.source as SourceId,
    externalId: String(row.external_id),
    url: String(row.url),
    title: String(row.title),
    company: row.company === null ? null : String(row.company),
    description: String(row.description),
    publishedAt: new Date(Number(row.published_at)),
    meta: JSON.parse(String(row.meta)),
    enriched: Number(row.enriched) === 1,
    status: row.status as Status,
    reason: row.reason === null ? null : String(row.reason),
    attempts: Number(row.attempts),
    score: row.score === null ? null : Number(row.score),
    assessment: assessment?.success ? assessment.data : null,
    letter: row.letter === null ? null : String(row.letter),
  };
}
