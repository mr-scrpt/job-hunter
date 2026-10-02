import { Check, ExternalLink, RotateCcw, X } from 'lucide-react';
import type { BoardItem, Decision } from '../api.ts';
import { Facts, ScoreBadge } from './Badges.tsx';

interface Props {
  item: BoardItem;
  englishLevel: string;
  selected: boolean;
  onOpen: () => void;
  onDecide: (decision: Decision) => void;
}

const DONE_LABEL: Record<Exclude<Decision, 'open'>, string> = { applied: '✅ Откликнулся', skipped: 'Не интересно' };

/** One vacancy in a section: summary + the three quick actions. Click anywhere else opens the detail panel. */
export function VacancyCard({ item, englishLevel, selected, onOpen, onDecide }: Props) {
  const done = item.decision !== 'open';
  return (
    <article
      onClick={onOpen}
      className={`group cursor-pointer rounded-2xl bg-white p-3.5 ring-1 transition hover:shadow-md ${
        selected ? 'shadow-md ring-2 ring-sky-500' : 'ring-slate-200'
      } ${done ? 'opacity-60 hover:opacity-100' : ''}`}
    >
      <div className="flex items-start gap-3">
        <ScoreBadge score={item.score} />
        <div className="min-w-0 flex-1">
          <h3 className="leading-snug font-semibold text-slate-900">{item.title}</h3>
          <p className="truncate text-sm text-slate-500">{item.company ?? 'Компания не указана'}</p>
        </div>
      </div>

      <div className="mt-2.5">
        <Facts item={item} englishLevel={englishLevel} />
      </div>

      {item.summary && <p className="mt-2 line-clamp-2 text-sm text-slate-600">{item.summary}</p>}

      <div className="mt-3 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-200"
        >
          <ExternalLink className="size-4" /> Открыть
        </a>
        {done ? (
          <>
            <span className="ml-1 text-sm text-slate-500">{DONE_LABEL[item.decision as Exclude<Decision, 'open'>]}</span>
            <button
              type="button"
              onClick={() => onDecide('open')}
              title="Вернуть в работу"
              className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
            >
              <RotateCcw className="size-4" /> Вернуть
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onDecide('applied')}
              className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
            >
              <Check className="size-4" /> Откликнулся
            </button>
            <button
              type="button"
              onClick={() => onDecide('skipped')}
              title="Не интересно"
              className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
            >
              <X className="size-4" /> <span className="hidden sm:inline">Не интересно</span>
            </button>
          </>
        )}
      </div>
    </article>
  );
}
