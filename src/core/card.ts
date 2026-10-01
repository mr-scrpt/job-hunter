import type { StoredVacancy } from './ports.ts';
import { escapeHtml, truncate } from './text.ts';

export type CardAction = 'applied' | 'skip' | 'rewrite' | 'undo';

export type CardButton = { kind: 'url'; label: string; url: string } | { kind: 'action'; label: string; action: CardAction };

export interface Card {
  html: string;
  rows: CardButton[][];
}

const SOURCE_LABEL: Record<StoredVacancy['source'], string> = { djinni: 'Djinni', dou: 'DOU' };
const AI_LABEL = { none: 'нет', some: 'частично', core: 'в основе' } as const;
const ROLE_LABEL = { frontend: 'frontend', backend: 'backend', fullstack: 'fullstack', other: 'другое' } as const;

// Telegram's hard limit is 4096 chars after entity parsing; leave headroom for tags.
const LETTER_MAX = 2200;

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

function statusLine(v: StoredVacancy): string | null {
  switch (v.status) {
    case 'applied':
      return '✅ <b>Отклик отправлен</b>';
    case 'skipped':
      return '⏭ <b>Пропущено</b>';
    default:
      return null;
  }
}

/** Telegram card for a vacancy that has an assessment and a letter. */
export function renderCard(v: StoredVacancy): Card {
  const a = v.assessment;
  const lines: string[] = [];

  const status = statusLine(v);
  if (status) lines.push(status, '');

  const score = v.score ?? a?.score ?? 0;
  lines.push(`${scoreBadge(score)} <b>${score}</b> · <b>${escapeHtml(v.title)}</b>`);
  lines.push(`🏢 ${factsLine(v)}`);

  if (a) {
    lines.push(`🤖 AI: ${AI_LABEL[a.aiFocus]} · роль: ${ROLE_LABEL[a.role]}`);
    lines.push('', `<i>${escapeHtml(a.summary)}</i>`);
    if (a.pros.length) lines.push(`➕ ${escapeHtml(a.pros.join('; '))}`);
    if (a.cons.length) lines.push(`➖ ${escapeHtml(a.cons.join('; '))}`);
  }

  const done = v.status === 'applied' || v.status === 'skipped';
  if (v.letter && !done) {
    lines.push('', '✉️ <b>Отклик</b> (нажми на блок, чтобы скопировать):');
    lines.push(`<pre>${escapeHtml(truncate(v.letter, LETTER_MAX))}</pre>`);
  }

  const open: CardButton = { kind: 'url', label: '🔗 Открыть вакансию', url: v.url };
  const rows: CardButton[][] = done
    ? [[open, { kind: 'action', label: '↩️ Вернуть', action: 'undo' }]]
    : [
        [open],
        [
          { kind: 'action', label: '✅ Отправил', action: 'applied' },
          { kind: 'action', label: '✏️ Переписать', action: 'rewrite' },
          { kind: 'action', label: '⏭ Пропустить', action: 'skip' },
        ],
      ];

  return { html: lines.join('\n'), rows };
}

const ACTION_CODE: Record<CardAction, string> = { applied: 'a', skip: 's', rewrite: 'r', undo: 'u' };
const CODE_ACTION = Object.fromEntries(Object.entries(ACTION_CODE).map(([k, v]) => [v, k])) as Record<string, CardAction>;

/** Callback payloads must fit Telegram's 64-byte limit: `a|djinni:850653`. */
export const encodeCallback = (action: CardAction, key: string): string => `${ACTION_CODE[action]}|${key}`;

export function decodeCallback(data: string): { action: CardAction; key: string } | undefined {
  const sep = data.indexOf('|');
  const action = CODE_ACTION[data.slice(0, sep)];
  const key = data.slice(sep + 1);
  return sep > 0 && action && key ? { action, key } : undefined;
}
