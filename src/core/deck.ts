import type { StoredVacancy } from './ports.ts';
import { escapeHtml, truncate } from './text.ts';

/**
 * The review deck: every vacancy waiting for a decision, shown one at a time in a single Telegram message.
 * This module is pure — it orders the queue, moves the cursor and renders; the bot adapter does the I/O.
 */

export type DeckAction = 'prev' | 'next' | 'applied' | 'skip' | 'regen' | 'refresh';

export type DeckButton = { kind: 'url'; label: string; url: string } | { kind: 'action'; label: string; action: DeckAction };

export interface DeckView {
  html: string;
  rows: DeckButton[][];
  /** Key of the vacancy on screen; free-text chat applies to it. */
  focusKey: string | null;
}

export interface DeckState {
  queue: StoredVacancy[];
  index: number;
}

export interface Contact {
  fullName: string;
  email?: string;
  phone?: string;
}

const code = (text: string): string => `<code>${escapeHtml(text)}</code>`;

/** Form-filling block: every value is its own <code> so one tap copies exactly that field. */
export function renderContact(contact: Contact): string {
  const lines = ['📝 <b>Для формы</b> (нажми на поле, чтобы скопировать):', `👤 ${code(contact.fullName)}`];
  if (contact.email) lines.push(`✉️ ${code(contact.email)}`);
  if (contact.phone) {
    // Forms usually have a separate country selector, so the code is shown but not part of the copy.
    const match = /^(\+\d{1,4})\s+(.+)$/.exec(contact.phone.trim());
    lines.push(match ? `📱 ${escapeHtml(match[1]!)} ${code(match[2]!)}` : `📱 ${code(contact.phone)}`);
  }
  return lines.join('\n');
}

/** Best match first; ties broken by freshness. */
export const orderQueue = (items: StoredVacancy[]): StoredVacancy[] =>
  [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.publishedAt.getTime() - a.publishedAt.getTime());

/**
 * Re-anchors the cursor after the queue changed: stays on the same vacancy if it is still queued,
 * otherwise keeps the position (so "applied" on item 2 of 5 shows the next one), clamped to the end.
 */
export function anchor(queue: StoredVacancy[], focusKey: string | null, fallbackIndex: number): number {
  const kept = focusKey ? queue.findIndex((v) => v.key === focusKey) : -1;
  if (kept >= 0) return kept;
  return Math.max(0, Math.min(fallbackIndex, queue.length - 1));
}

export function step(state: DeckState, delta: -1 | 1): number {
  return Math.max(0, Math.min(state.index + delta, state.queue.length - 1));
}

const SOURCE_LABEL: Record<StoredVacancy['source'], string> = { djinni: 'Djinni', dou: 'DOU' };
const AI_LABEL = { none: 'нет', some: 'частично', core: 'в основе' } as const;
const ROLE_LABEL = { frontend: 'frontend', backend: 'backend', fullstack: 'fullstack', other: 'другое' } as const;

// Telegram caps a message at 4096 chars after entity parsing; the letter gets what the header leaves.
const MESSAGE_MAX = 4000;

const scoreBadge = (score: number): string => (score >= 80 ? '🟢' : score >= 65 ? '🟡' : '🟠');

function salaryLabel({ salaryMinUsd: min, salaryMaxUsd: max }: StoredVacancy['meta']): string | null {
  if (min !== undefined && max !== undefined) return min === max ? `$${min}` : `$${min}–${max}`;
  if (max !== undefined) return `до $${max}`;
  if (min !== undefined) return `от $${min}`;
  return null;
}

function factsLine(v: StoredVacancy): string {
  const { meta } = v;
  const facts = [
    v.company ?? 'компания не указана',
    SOURCE_LABEL[v.source],
    salaryLabel(meta),
    meta.remote ? 'удалёнка' : null,
    meta.english ? `EN ${meta.english}` : null,
    meta.experienceYears !== undefined ? `опыт ${meta.experienceYears}+ г.` : null,
    meta.applicants !== undefined ? `откликов ${meta.applicants}` : null,
  ];
  return facts.filter((f): f is string => Boolean(f)).map(escapeHtml).join(' · ');
}

const navRow = (index: number, total: number): DeckButton[] => {
  const row: DeckButton[] = [];
  if (index > 0) row.push({ kind: 'action', label: '◀️ Назад', action: 'prev' });
  if (index < total - 1) row.push({ kind: 'action', label: 'Дальше ▶️', action: 'next' });
  return row;
};

export function renderDeck(
  state: DeckState,
  opts: { note?: string; busy?: string; contact?: Contact; scanIntervalMinutes?: number } = {},
): DeckView {
  const { queue, index } = state;
  const refresh: DeckButton = { kind: 'action', label: '🔄 Обновить', action: 'refresh' };

  if (queue.length === 0) {
    const every = opts.scanIntervalMinutes
      ? `Новые проверяю каждые ${opts.scanIntervalMinutes} ${plural(opts.scanIntervalMinutes, ['минуту', 'минуты', 'минут'])}. `
      : '';
    const lines = ['✅ <b>Все вакансии разобраны.</b>', '', `${every}/scan — проверить сейчас.`];
    if (opts.note) lines.unshift(escapeHtml(opts.note), '');
    return { html: lines.join('\n'), rows: [[refresh]], focusKey: null };
  }

  const v = queue[index] as StoredVacancy;
  const a = v.assessment;
  const score = v.score ?? a?.score ?? 0;

  const head: string[] = [];
  if (opts.note) head.push(`ℹ️ ${escapeHtml(opts.note)}`, '');
  head.push(`📋 <b>Вакансия ${index + 1} из ${queue.length}</b>`, '');
  head.push(`${scoreBadge(score)} <b>${score}</b> · <b>${escapeHtml(v.title)}</b>`);
  head.push(`🏢 ${factsLine(v)}`);
  if (a) {
    head.push(`🤖 AI: ${AI_LABEL[a.aiFocus]} · роль: ${ROLE_LABEL[a.role]}`);
    head.push('', `<i>${escapeHtml(a.summary)}</i>`);
    if (a.pros.length) head.push(`➕ ${escapeHtml(a.pros.join('; '))}`);
    if (a.cons.length) head.push(`➖ ${escapeHtml(a.cons.join('; '))}`);
  }

  const tail: string[] = [];
  tail.push('', opts.busy ? `⏳ <i>${escapeHtml(opts.busy)}</i>` : '💬 <i>Напиши в чат, что поменять в отклике, или задай вопрос по вакансии.</i>');

  let html = head.join('\n');
  if (opts.contact) html += `\n\n${renderContact(opts.contact)}`;
  if (v.letter) {
    const intro = '\n\n💌 <b>Отклик</b> (нажми на текст, чтобы скопировать):\n';
    const budget = MESSAGE_MAX - html.length - intro.length - tail.join('\n').length - 20;
    html += `${intro}<pre>${escapeHtml(truncate(v.letter, Math.max(200, budget)))}</pre>`;
  }
  html += tail.join('\n');

  const rows: DeckButton[][] = [];
  const nav = navRow(index, queue.length);
  if (nav.length) rows.push(nav);
  rows.push([
    { kind: 'action', label: '✅ Отправил', action: 'applied' },
    { kind: 'action', label: '⏭ Пропустить', action: 'skip' },
  ]);
  rows.push([{ kind: 'url', label: '🔗 Открыть', url: v.url }, { kind: 'action', label: '🎲 Другой вариант', action: 'regen' }]);

  return { html, rows, focusKey: v.key };
}

/** Text of the batch announcement sent when new vacancies arrive. */
export function announcement(freshCount: number, queueSize: number): string {
  const word = plural(freshCount, ['новая вакансия', 'новые вакансии', 'новых вакансий']);
  return queueSize > freshCount
    ? `🔔 ${freshCount} ${word}. Всего в очереди: ${queueSize}.`
    : `🔔 ${freshCount} ${word} на разбор.`;
}

export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// Callback payloads: "d|next". Staleness is detected from the message the button belongs to, not the payload.
export const encodeDeckCallback = (action: DeckAction): string => `d|${action}`;

const ACTIONS: readonly DeckAction[] = ['prev', 'next', 'applied', 'skip', 'regen', 'refresh'];

export function decodeDeckCallback(data: string): DeckAction | undefined {
  const [prefix, action] = data.split('|');
  return prefix === 'd' && ACTIONS.includes(action as DeckAction) ? (action as DeckAction) : undefined;
}
