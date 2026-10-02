import type { BoardItem, Section } from './api.ts';

/** Pure view logic for the board: day strip, sections, filters. Kept out of components so it's testable. */

export type Filter = 'open' | 'applied' | 'skipped' | 'all';

export const SECTION_ORDER: Section[] = ['fullstack', 'backend', 'frontend', 'other'];
export const SECTION_LABEL: Record<Section, string> = {
  fullstack: 'Fullstack',
  backend: 'Backend',
  frontend: 'Frontend',
  other: 'Другое',
};

/** YYYY-MM-DD → Date at noon UTC (safe from DST/offset shifts when only the calendar day matters). */
const asDate = (day: string): Date => new Date(`${day}T12:00:00Z`);
export const addDays = (day: string, delta: number): string => {
  const d = asDate(day);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

const WEEKDAY = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' });
const MONTH_DAY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const LONG = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

export function dayLabel(day: string, today: string): { top: string; bottom: string } {
  const date = asDate(day);
  if (day === today) return { top: 'Сегодня', bottom: MONTH_DAY.format(date).replace('.', '') };
  if (day === addDays(today, -1)) return { top: 'Вчера', bottom: MONTH_DAY.format(date).replace('.', '') };
  return { top: WEEKDAY.format(date).replace('.', ''), bottom: MONTH_DAY.format(date).replace('.', '') };
}

export const longDay = (day: string, today: string): string => {
  const label = LONG.format(asDate(day));
  if (day === today) return `Сегодня, ${label}`;
  if (day === addDays(today, -1)) return `Вчера, ${label}`;
  return label[0]!.toUpperCase() + label.slice(1);
};

export interface DayCell {
  day: string;
  open: number;
  total: number;
}

/** Days from the earliest vacancy (within `max`) to today, oldest first, at least `min`, with counts per day. */
export function dayStrip(items: BoardItem[], today: string, { min = 7, max = 14 } = {}): DayCell[] {
  const earliest = items.reduce((acc, it) => (it.day < acc ? it.day : acc), today);
  const daysBack = Math.round((asDate(today).getTime() - asDate(earliest).getTime()) / 86_400_000);
  const span = Math.min(max, Math.max(min, daysBack + 1));
  const cells: DayCell[] = [];
  for (let i = span - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    const onDay = items.filter((it) => it.day === day);
    cells.push({ day, open: onDay.filter((it) => it.decision === 'open').length, total: onDay.length });
  }
  return cells;
}

/** `null` day = every day. */
export function visibleItems(items: BoardItem[], day: string | null, filter: Filter): BoardItem[] {
  return items.filter((it) => (day === null || it.day === day) && (filter === 'all' || it.decision === filter));
}

export interface SectionGroup {
  section: Section;
  /** English within the candidate's level first, then the "stretch" ones. */
  fit: BoardItem[];
  stretch: BoardItem[];
}

/** Items are already sorted by the server (fit first, then score); grouping keeps that order. */
export function groupBySection(items: BoardItem[]): SectionGroup[] {
  return SECTION_ORDER.map((section) => {
    const inSection = items.filter((it) => it.section === section);
    return { section, fit: inSection.filter((it) => !it.stretch), stretch: inSection.filter((it) => it.stretch) };
  }).filter((g) => g.fit.length + g.stretch.length > 0 || g.section !== 'other');
}

export const SOURCE_LABEL: Record<BoardItem['source'], string> = { djinni: 'Djinni', dou: 'DOU', robota: 'Robota.ua' };

export function relativeTime(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

/** Score badge colour band. */
export const scoreTone = (score: number): 'high' | 'mid' | 'low' => (score >= 75 ? 'high' : score >= 62 ? 'mid' : 'low');
