import type { BoardItem } from '../api.ts';
import { scoreTone, SOURCE_LABEL } from '../board.ts';

const TONE = {
  high: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  mid: 'bg-sky-100 text-sky-800 ring-sky-200',
  low: 'bg-slate-100 text-slate-600 ring-slate-200',
};

export function ScoreBadge({ score, large = false }: { score: number; large?: boolean }) {
  return (
    <span
      title="Насколько подходит, по оценке Claude"
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-semibold tabular-nums ring-1 ring-inset ${TONE[scoreTone(score)]} ${large ? 'h-10 min-w-10 px-2 text-lg' : 'h-7 min-w-7 px-1.5 text-sm'}`}
    >
      {score}
    </span>
  );
}

export function Chip({ children, tone = 'slate', title }: { children: React.ReactNode; tone?: 'slate' | 'amber' | 'violet' | 'emerald' | 'sky'; title?: string }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600',
    sky: 'bg-sky-100 text-sky-800',
    amber: 'bg-amber-100 text-amber-800',
    violet: 'bg-violet-100 text-violet-700',
    emerald: 'bg-emerald-100 text-emerald-700',
  };
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${tones[tone]}`}>
      {children}
    </span>
  );
}

const LANGUAGE_LABEL = { uk: 'UA', ru: 'RU', en: 'EN' } as const;
const LANGUAGE_TITLE = { uk: 'украинском', ru: 'русском', en: 'английском' } as const;

/** Language of the posting text: UA / RU / EN, or e.g. UA+EN for bilingual ones. */
export function LanguageChip({ item }: { item: BoardItem }) {
  const other = item.language === 'en' ? 'UA' : 'EN';
  const label = item.languageMixed ? `${LANGUAGE_LABEL[item.language]}+${other}` : LANGUAGE_LABEL[item.language];
  return (
    <Chip tone={item.language === 'en' ? 'sky' : 'slate'} title={`Текст вакансии на ${LANGUAGE_TITLE[item.language]}${item.languageMixed ? ', частично на другом языке' : ''}`}>
      Текст {label}
    </Chip>
  );
}

/** The small facts row shared by the card and the detail panel. */
export function Facts({ item, englishLevel }: { item: BoardItem; englishLevel: string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <LanguageChip item={item} />
      {item.aiFocus === 'core' && <Chip tone="violet">✨ AI в основе</Chip>}
      {item.aiFocus === 'some' && <Chip tone="violet">AI</Chip>}
      {item.english && (
        <Chip tone={item.stretch ? 'amber' : 'slate'} title={item.stretch ? `Выше твоего ${englishLevel}` : 'Требуемый английский'}>
          {item.stretch ? '⚠️ ' : ''}EN {item.english}
        </Chip>
      )}
      {item.englishUnclear && (
        <Chip tone="amber" title="Текст на английском, а уровень не указан — стоит уточнить">
          EN ?
        </Chip>
      )}
      {item.salary && <Chip tone="emerald">{item.salary}</Chip>}
      {item.remote === true && <Chip>удалённо</Chip>}
      {item.remote === false && <Chip>офис</Chip>}
      <Chip>{SOURCE_LABEL[item.source]}</Chip>
      {item.applicants !== null && <Chip title="Откликов на Djinni">👥 {item.applicants}</Chip>}
      {item.manual && <Chip>добавлено вручную</Chip>}
    </div>
  );
}
