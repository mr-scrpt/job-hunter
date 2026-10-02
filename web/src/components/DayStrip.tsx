import { useEffect, useRef } from 'react';
import { dayLabel, dayStrip, type DayCell } from '../board.ts';
import type { BoardItem } from '../api.ts';

interface Props {
  items: BoardItem[];
  today: string;
  /** `null` = all days. */
  selected: string | null;
  onSelect: (day: string | null) => void;
}

/** Horizontal two-week strip, today on the right; dot = still undecided vacancies that day. */
export function DayStrip({ items, today, selected, onSelect }: Props) {
  const cells = dayStrip(items, today);
  const scroller = useRef<HTMLDivElement>(null);

  // Start scrolled to today (the right end) on narrow screens.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);

  return (
    <div className="flex items-stretch gap-2">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`shrink-0 rounded-xl px-3 text-sm font-medium transition ${selected === null ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100'}`}
      >
        Все дни
      </button>
      <div ref={scroller} className="no-scrollbar -my-2 flex flex-1 gap-1.5 overflow-x-auto scroll-smooth py-2 pr-1.5">
        {cells.map((cell) => (
          <DayButton key={cell.day} cell={cell} today={today} active={selected === cell.day} onClick={() => onSelect(cell.day)} />
        ))}
      </div>
    </div>
  );
}

function DayButton({ cell, today, active, onClick }: { cell: DayCell; today: string; active: boolean; onClick: () => void }) {
  const { top, bottom } = dayLabel(cell.day, today);
  const empty = cell.total === 0;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={empty && !active}
      className={`relative flex w-16 shrink-0 flex-col items-center rounded-xl py-1.5 text-center transition ${
        active ? 'bg-slate-900 text-white' : empty ? 'text-slate-300' : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100'
      }`}
    >
      <span className="text-[11px] leading-4 capitalize opacity-80">{top}</span>
      <span className="text-sm leading-5 font-semibold">{bottom}</span>
      <span className={`text-[11px] leading-4 tabular-nums ${active ? 'text-white/80' : 'text-slate-400'}`}>{empty ? '—' : cell.total}</span>
      {cell.open > 0 && (
        <span
          title={`Не разобрано: ${cell.open}`}
          className={`absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-bold tabular-nums ${active ? 'bg-white text-slate-900' : 'bg-sky-500 text-white'}`}
        >
          {cell.open}
        </span>
      )}
    </button>
  );
}
