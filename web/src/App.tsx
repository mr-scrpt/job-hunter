import { Link2, Loader2, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Board, type BoardItem, type Decision, type Section } from './api.ts';
import { groupBySection, longDay, relativeTime, SECTION_LABEL, visibleItems, type Filter } from './board.ts';
import { DayStrip } from './components/DayStrip.tsx';
import { DetailPanel } from './components/DetailPanel.tsx';
import { SectionColumn } from './components/SectionColumn.tsx';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'open', label: 'Новые' },
  { id: 'applied', label: 'Откликнулся' },
  { id: 'skipped', label: 'Не интересно' },
  { id: 'all', label: 'Все' },
];

const POLL_MS = 60_000;

interface Toast {
  text: string;
  undo?: () => void;
  error?: boolean;
}

export function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** `undefined` = not chosen yet (defaults to today when it has vacancies, else all days). */
  const [day, setDay] = useState<string | null | undefined>(undefined);
  const [filter, setFilter] = useState<Filter>('open');
  const [tab, setTab] = useState<Section>('fullstack');
  const [selectedKey, setSelectedKey] = useState<string | null>(() => new URLSearchParams(location.search).get('v'));
  const [toast, setToast] = useState<Toast | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setBoard(await api.board());
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  // Initial load, polling, and refresh when the tab comes back into view.
  useEffect(() => {
    void load();
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(), POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  // While a scan runs, poll faster to pick up its results.
  useEffect(() => {
    if (!board?.scanning) return;
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [board?.scanning, load]);

  // Selected vacancy in the URL (?v=key) so a reload or the back button keeps the panel.
  useEffect(() => {
    const url = new URL(location.href);
    if (selectedKey) url.searchParams.set('v', selectedKey);
    else url.searchParams.delete('v');
    history.replaceState(null, '', url);
  }, [selectedKey]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.undo ? 6_000 : 4_000);
    return () => clearTimeout(timer);
  }, [toast]);

  const effectiveDay = useMemo(() => {
    if (day !== undefined || !board) return day ?? null;
    return board.items.some((i) => i.day === board.today && i.decision === 'open') ? board.today : null;
  }, [day, board]);

  const visible = useMemo(() => (board ? visibleItems(board.items, effectiveDay, filter) : []), [board, effectiveDay, filter]);
  const groups = useMemo(() => groupBySection(visible), [visible]);
  const selected = board?.items.find((i) => i.key === selectedKey) ?? null;

  const patchItem = (key: string, patch: Partial<BoardItem>) =>
    setBoard((b) => (b ? { ...b, items: b.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) } : b));

  const decide = async (item: BoardItem, decision: Decision, { quiet = false } = {}) => {
    const previous = item.decision;
    patchItem(item.key, { decision });
    try {
      await api.decide(item.key, decision);
      if (!quiet && decision !== 'open') {
        setToast({
          text: decision === 'applied' ? `✅ Отклик отмечен: ${item.title}` : `Скрыто: ${item.title}`,
          undo: () => void decide({ ...item, decision }, previous, { quiet: true }),
        });
      }
      // The panel moves on to the next undecided vacancy in the same view.
      if (decision !== 'open' && selectedKey === item.key) {
        const next = visible.find((i) => i.key !== item.key && i.decision === 'open');
        setSelectedKey(next?.key ?? null);
      }
    } catch (e) {
      patchItem(item.key, { decision: previous });
      setToast({ text: (e as Error).message, error: true });
    }
  };

  const scan = async () => {
    try {
      const { started } = await api.scan();
      setToast({ text: started ? 'Проверяю вакансии… это пара минут' : 'Проверка уже идёт' });
      void load();
    } catch (e) {
      setToast({ text: (e as Error).message, error: true });
    }
  };

  const addByLink = async () => {
    const url = prompt('Ссылка на вакансию Djinni, DOU или Robota.ua:')?.trim();
    if (!url) return;
    setAdding(true);
    setToast({ text: 'Читаю вакансию, оцениваю и пишу отклик… (~1 мин)' });
    try {
      const item = await api.add(url);
      await load();
      setDay(null);
      setFilter('open');
      setTab(item.section);
      setSelectedKey(item.key);
      setToast({ text: `Добавлено: ${item.title}` });
    } catch (e) {
      setToast({ text: (e as Error).message, error: true });
    } finally {
      setAdding(false);
    }
  };

  if (!board) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center text-slate-500">
        {loadError ? <p className="max-w-sm">{loadError}</p> : <Loader2 className="size-6 animate-spin" />}
      </div>
    );
  }

  const openCount = (s: Section) => visible.filter((i) => i.section === s).length;
  const mainSections: Section[] = ['fullstack', 'backend', 'frontend'];
  const other = groups.find((g) => g.section === 'other');
  const otherCount = other ? other.fit.length + other.stretch.length : 0;
  const tabs: Section[] = otherCount > 0 ? [...mainSections, 'other'] : mainSections;

  return (
    <div className="min-h-dvh">
      {/* Top bar */}
      <header className="border-b border-slate-200 bg-slate-50/90 backdrop-blur lg:sticky lg:top-0 lg:z-20">
        <div className="mx-auto max-w-[1500px] space-y-3 px-3 py-3 sm:px-5">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-slate-900">Вакансии</h1>
            <span className="hidden truncate text-sm text-slate-500 sm:inline">
              {board.scanning ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="size-3.5 animate-spin" /> проверяю…
                </span>
              ) : board.lastScanAt ? (
                `проверено ${relativeTime(board.lastScanAt)}${board.scanIntervalMinutes > 0 ? ` · каждые ${board.scanIntervalMinutes} мин` : ''}`
              ) : null}
            </span>
            <div className="ml-auto flex gap-1.5">
              <button
                type="button"
                onClick={addByLink}
                disabled={adding}
                title="Добавить вакансию по ссылке"
                className="inline-flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100 disabled:opacity-50"
              >
                {adding ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
                <span className="hidden sm:inline">По ссылке</span>
                <Plus className="size-3.5 sm:hidden" />
              </button>
              <button
                type="button"
                onClick={scan}
                disabled={board.scanning}
                title="Проверить вакансии сейчас"
                className="inline-flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100 disabled:opacity-50"
              >
                <RefreshCw className={`size-4 ${board.scanning ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">Проверить</span>
              </button>
            </div>
          </div>

          <DayStrip items={board.items} today={board.today} selected={effectiveDay} onSelect={setDay} />

          <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
            {FILTERS.map((f) => {
              const n = visibleItems(board.items, effectiveDay, f.id).length;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  className={`shrink-0 rounded-full px-3 py-1 text-sm font-medium transition ${
                    filter === f.id ? 'bg-sky-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {f.label} <span className="tabular-nums opacity-70">{n}</span>
                </button>
              );
            })}
          </div>

        </div>
      </header>

      {/* Mobile: one section at a time; the only sticky part on small screens */}
      <div className="sticky top-0 z-20 border-b border-slate-200 bg-slate-50/90 px-3 py-2 backdrop-blur lg:hidden">
          <div className="grid gap-1 rounded-xl bg-slate-200/70 p-1" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
            {tabs.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setTab(s)}
                className={`rounded-lg py-1.5 text-sm font-medium transition ${tab === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}
              >
                {SECTION_LABEL[s]} <span className="tabular-nums opacity-60">{openCount(s)}</span>
              </button>
            ))}
          </div>
      </div>

      <main className="mx-auto max-w-[1500px] px-3 py-4 sm:px-5">
        <p className="mb-3 px-1 text-sm text-slate-500">
          {effectiveDay ? longDay(effectiveDay, board.today) : 'Все дни'} · {visible.length}{' '}
          {filter === 'open' ? 'не разобрано' : filter === 'applied' ? 'с откликом' : filter === 'skipped' ? 'скрыто' : 'всего'}
        </p>

        {visible.length === 0 ? (
          <EmptyState filter={filter} day={effectiveDay} onAllDays={() => setDay(null)} intervalMinutes={board.scanIntervalMinutes} />
        ) : (
          <>
            {/* Desktop: three columns side by side */}
            <div className="hidden gap-5 lg:grid lg:grid-cols-3">
              {mainSections.map((s) => {
                const group = groups.find((g) => g.section === s) ?? { section: s, fit: [], stretch: [] };
                return (
                  <SectionColumn
                    key={s}
                    group={group}
                    englishLevel={board.englishLevel}
                    selectedKey={selectedKey}
                    onOpen={(i) => setSelectedKey(i.key)}
                    onDecide={(i, d) => void decide(i, d)}
                  />
                );
              })}
            </div>
            {other && otherCount > 0 && (
              <div className="mt-8 hidden lg:block">
                <SectionColumn
                  group={other}
                  englishLevel={board.englishLevel}
                  selectedKey={selectedKey}
                  onOpen={(i) => setSelectedKey(i.key)}
                  onDecide={(i, d) => void decide(i, d)}
                />
              </div>
            )}

            {/* Mobile: the selected tab */}
            <div className="lg:hidden">
              <SectionColumn
                bare
                group={groups.find((g) => g.section === tab) ?? { section: tab, fit: [], stretch: [] }}
                englishLevel={board.englishLevel}
                selectedKey={selectedKey}
                onOpen={(i) => setSelectedKey(i.key)}
                onDecide={(i, d) => void decide(i, d)}
              />
            </div>
          </>
        )}
      </main>

      {/* Detail: right drawer on desktop, full screen on mobile */}
      {selected && (
        <>
          <div className="fixed inset-0 z-30 bg-slate-900/30 backdrop-blur-[1px]" onClick={() => setSelectedKey(null)} />
          <aside className="fixed inset-0 z-40 flex flex-col shadow-2xl sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[640px] sm:max-w-[92vw]">
            <DetailPanel
              item={selected}
              board={board}
              onClose={() => setSelectedKey(null)}
              onDecide={(d) => void decide(selected, d)}
              onLetter={(letter) => patchItem(selected.key, { letter })}
              onError={(text) => setToast({ text, error: true })}
            />
          </aside>
        </>
      )}

      {toast && (
        <div className="fixed inset-x-3 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-md items-center gap-3 rounded-2xl bg-slate-900 px-4 py-3 text-sm text-white shadow-xl">
          <span className={`flex-1 ${toast.error ? 'text-rose-300' : ''}`}>{toast.text}</span>
          {toast.undo && (
            <button
              type="button"
              onClick={() => {
                toast.undo?.();
                setToast(null);
              }}
              className="font-semibold text-sky-300 hover:text-sky-200"
            >
              Отменить
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState({ filter, day, onAllDays, intervalMinutes }: { filter: Filter; day: string | null; onAllDays: () => void; intervalMinutes: number }) {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-dashed border-slate-300 p-8 text-center text-slate-500">
      {filter === 'open' ? (
        <>
          <p className="font-medium text-slate-700">Всё разобрано 🎉</p>
          <p className="mt-1 text-sm">Новые вакансии проверяю каждые {intervalMinutes} мин и пришлю уведомление в Telegram.</p>
        </>
      ) : (
        <p>Здесь пусто.</p>
      )}
      {day && (
        <button type="button" onClick={onAllDays} className="mt-3 text-sm font-medium text-sky-700 hover:underline">
          Показать все дни
        </button>
      )}
    </div>
  );
}
