import type { BoardItem, Decision } from '../api.ts';
import type { SectionGroup } from '../board.ts';
import { SECTION_LABEL } from '../board.ts';
import { VacancyCard } from './VacancyCard.tsx';

interface Props {
  group: SectionGroup;
  englishLevel: string;
  selectedKey: string | null;
  onOpen: (item: BoardItem) => void;
  onDecide: (item: BoardItem, decision: Decision) => void;
  /** Hide the heading (mobile tabs already name the section). */
  bare?: boolean;
}

/** One column: best-fit vacancies first, then the ones that need more English than the candidate has. */
export function SectionColumn({ group, englishLevel, selectedKey, onOpen, onDecide, bare = false }: Props) {
  const total = group.fit.length + group.stretch.length;
  const card = (item: BoardItem) => (
    <VacancyCard
      key={item.key}
      item={item}
      englishLevel={englishLevel}
      selected={item.key === selectedKey}
      onOpen={() => onOpen(item)}
      onDecide={(d) => onDecide(item, d)}
    />
  );

  return (
    <section className="min-w-0">
      {!bare && (
        <h2 className="mb-3 flex items-baseline gap-2 px-1 text-sm font-semibold tracking-wide text-slate-500 uppercase">
          {SECTION_LABEL[group.section]}
          <span className="font-normal tabular-nums">{total}</span>
        </h2>
      )}

      {total === 0 && <p className="rounded-2xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400">Пусто</p>}

      <div className="flex flex-col gap-3">{group.fit.map(card)}</div>

      {group.stretch.length > 0 && (
        <>
          <div className="my-4 flex items-center gap-2 px-1 text-xs font-medium text-amber-700">
            <span className="h-px flex-1 bg-amber-200" />
            Английский выше {englishLevel} · {group.stretch.length}
            <span className="h-px flex-1 bg-amber-200" />
          </div>
          <div className="flex flex-col gap-3">{group.stretch.map(card)}</div>
        </>
      )}
    </section>
  );
}
