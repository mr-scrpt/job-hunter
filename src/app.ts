import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Bot } from 'grammy';
import { parse as parseYaml } from 'yaml';
import { ClaudeCli } from './adapters/llm/claude-cli.ts';
import { DjinniSource } from './adapters/sources/djinni.ts';
import { DouSource } from './adapters/sources/dou.ts';
import { HttpClient } from './adapters/sources/http.ts';
import { RobotaSource } from './adapters/sources/robota.ts';
import { SqliteStore } from './adapters/store/sqlite.ts';
import { silentNotifier, TelegramNotifier } from './adapters/telegram/bot.ts';
import type { PipelineDeps, ScanReport } from './core/pipeline.ts';
import type { Notifier, Store, VacancySource } from './core/ports.ts';
import { ProfileSchema, type Profile } from './schemas/profile.ts';

export const ROOT = resolve(import.meta.dirname, '..');

const expandHome = (path: string): string => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

export interface App {
  profile: Profile;
  resume: string;
  store: SqliteStore;
  sources: VacancySource[];
  llm: ClaudeCli;
  notifier: Notifier;
  /** Present when a bot token is configured. */
  bot: Bot | undefined;
  /** Where the web board is opened, including the access key. */
  boardUrl: string;
  accessKey: string;
  pipeline: (overrides?: Partial<PipelineDeps>) => PipelineDeps;
}

export function loadProfile(path = process.env.JOB_HUNTER_PROFILE ?? join(ROOT, 'config/profile.yaml')): Profile {
  if (!existsSync(path)) throw new Error(`Profile not found: ${path} (copy config/profile.example.yaml to config/profile.yaml)`);
  return ProfileSchema.parse(parseYaml(readFileSync(path, 'utf8')));
}

export function loadResume(file: string): string {
  const path = expandHome(file);
  if (!existsSync(path)) throw new Error(`Resume not found: ${path}`);
  const text = path.toLowerCase().endsWith('.pdf')
    ? execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], { encoding: 'utf8' })
    : readFileSync(path, 'utf8');
  return text
    .replace(/\f/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const SECRETS = '~/.local/share/secrets';

/** Bot token: env var first, then the secrets file (never stored in the repo). */
export function loadToken(): string | undefined {
  const fromEnv = process.env.JOB_HUNTER_TG_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const file = expandHome(process.env.JOB_HUNTER_TOKEN_FILE ?? `${SECRETS}/job-hunter.token`);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() || undefined : undefined;
}

/** Web access key: env, else a secrets file created on first run (random, mode 600). */
export function loadAccessKey(): string {
  const fromEnv = process.env.JOB_HUNTER_WEB_KEY?.trim();
  if (fromEnv) return fromEnv;
  const file = expandHome(process.env.JOB_HUNTER_WEB_KEY_FILE ?? `${SECRETS}/job-hunter-web.key`);
  if (existsSync(file)) {
    const key = readFileSync(file, 'utf8').trim();
    if (key) return key;
  }
  const key = randomBytes(18).toString('base64url');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  return key;
}

/** First non-internal IPv4: the default board address when web.publicUrl is not set. */
function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return 'localhost';
}

export function createApp(): App {
  const profile = loadProfile();
  const resume = loadResume(profile.candidate.resumeFile);
  const store = new SqliteStore(process.env.JOB_HUNTER_DB ?? join(ROOT, 'data/job-hunter.db'));
  const http = new HttpClient();

  const sources: VacancySource[] = [];
  if (profile.sources.djinni.enabled) sources.push(new DjinniSource(profile.sources.djinni, http));
  if (profile.sources.dou.enabled) sources.push(new DouSource(profile.sources.dou, http));
  if (profile.sources.robota?.enabled) sources.push(new RobotaSource(profile.sources.robota, http));

  const llm = new ClaudeCli({
    promptsDir: join(ROOT, 'prompts'),
    assessModel: profile.scoring.assessModel,
    letterModel: profile.scoring.letterModel,
    bin: process.env.JOB_HUNTER_CLAUDE_BIN ?? 'claude',
  });

  const accessKey = loadAccessKey();
  const base = (profile.web.publicUrl ?? `http://${lanAddress()}:${profile.web.port}`).replace(/\/+$/, '');
  const boardUrl = `${base}/?k=${accessKey}`;

  const token = loadToken();
  const bot = token ? new Bot(token) : undefined;
  const notifier: Notifier = bot ? new TelegramNotifier(bot, store, boardUrl) : silentNotifier;

  const pipeline = (overrides: Partial<PipelineDeps> = {}): PipelineDeps => ({
    store,
    sources,
    llm,
    notifier,
    profile,
    resume,
    log: (m) => console.error(`[scan] ${m}`),
    ...overrides,
  });

  return { profile, resume, store, sources, llm, notifier, bot, boardUrl, accessKey, pipeline };
}

export function formatReport(report: ScanReport | 'locked'): string {
  if (report === 'locked') return 'Проверка уже идёт в другом процессе.';
  const lines = [
    `Новых вакансий: ${report.inserted} (в лентах ${report.fetched})`,
    `Отсеяно фильтрами: ${report.filtered}, дублей: ${report.duplicates}`,
    `Оценено Claude: ${report.assessed} → подходят ${report.ready}, слабые ${report.low}`,
    `Добавлено на доску: ${report.notified}`,
  ];
  if (report.deferred) lines.push(`Отложено до следующей проверки: ${report.deferred}`);
  if (report.unqueued) lines.push(`Убрано с доски по новым фильтрам: ${report.unqueued}`);
  if (report.revived) lines.push(`Возвращено на переоценку (смягчён английский): ${report.revived}`);
  if (report.errors) lines.push(`Ошибок обработки: ${report.errors}`);
  if (report.llmUnavailable) lines.push('⚠️ Claude недоступен (лимит подписки или нет входа) — продолжу позже.');
  for (const e of report.sourceErrors) lines.push(`⚠️ Источник: ${e}`);
  return lines.join('\n');
}

const STATUS_LABEL: Record<string, string> = {
  new: 'в очереди на оценку',
  filtered: 'отсеяно фильтрами',
  duplicate: 'дубли',
  low: 'не подошли',
  ready: 'ждут публикации',
  notified: 'на доске, ждут решения',
  applied: 'откликнулся',
  skipped: 'не интересно',
  error: 'ошибки',
};

export function formatStats(store: Store): string {
  const counts = store.countByStatus();
  const day = new Date(Date.now() - 86_400_000);
  const week = new Date(Date.now() - 7 * 86_400_000);
  const lines = [
    `Откликов: за сутки ${store.countEventsSince('applied', day)}, за неделю ${store.countEventsSince('applied', week)}`,
    '',
    ...Object.entries(STATUS_LABEL)
      .filter(([status]) => counts[status])
      .map(([status, label]) => `${label}: ${counts[status]}`),
  ];
  const last = store.getKv('last_scan');
  if (last) {
    const { at } = JSON.parse(last) as { at: string };
    lines.push('', `Последняя проверка: ${new Date(at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}`);
  }
  return lines.join('\n');
}
