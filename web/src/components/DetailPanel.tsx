import { Check, ExternalLink, Languages, Loader2, RefreshCw, RotateCcw, Send, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type Board, type BoardItem, type ChatTurn, type Decision, type LetterNote } from '../api.ts';
import { longDay, SECTION_LABEL } from '../board.ts';
import { Facts, ScoreBadge } from './Badges.tsx';
import { CopyButton } from './CopyButton.tsx';

interface Props {
  item: BoardItem;
  board: Board;
  onClose: () => void;
  onDecide: (decision: Decision) => void;
  /** Letter changed on the server (regenerate / chat edit). */
  onLetter: (letter: string) => void;
  onError: (message: string) => void;
}

const SUGGESTIONS = ['Короче', 'Добавь про NestJS', 'Сделай теплее', 'Что за компания?', 'Стоит ли откликаться?'];

const NOTE_BUTTONS: Array<{ note: LetterNote; label: string; hint: string }> = [
  { note: 'level', label: 'Мой уровень английского', hint: 'Абзац: читаю документацию и веду переписку, без опыта живого общения' },
  { note: 'clarify', label: 'Уточнить требование', hint: 'Абзац-вопрос: какой английский нужен, будут ли созвоны' },
];

/** Why the English block is worth a look for this vacancy (or null when nothing points at English). */
function englishHint(item: BoardItem, level: string): string | null {
  if (item.stretch) return `Требуют ${item.english}, у тебя ${level}.`;
  if (item.englishUnclear) return 'Текст на английском, а уровень не указан — возможно, английский нужен.';
  if (item.english) return `Указан английский ${item.english}.`;
  return null;
}

/** Everything needed to apply: the letter, contact fields for the form, actions, and a chat that edits the letter. */
export function DetailPanel({ item, board, onClose, onDecide, onLetter, onError }: Props) {
  const [busy, setBusy] = useState<'regen' | 'chat' | 'note' | null>(null);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [message, setMessage] = useState('');
  const [flash, setFlash] = useState<string | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHistory([]);
    setMessage('');
    setFlash(null);
    body.current?.scrollTo({ top: 0 });
    api.chatHistory(item.key).then((r) => setHistory(r.history), () => {});
  }, [item.key]);

  // Braces matter: scrollIntoView returns a Promise in current Chrome, and React would call it as the cleanup.
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [history.length, busy]);

  // Esc closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const regenerate = async () => {
    setBusy('regen');
    try {
      const { letter } = await api.regenerate(item.key);
      onLetter(letter);
      setFlash('Новый вариант готов');
    } catch (e) {
      onError(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  };

  const toggleNote = async (note: LetterNote, on: boolean) => {
    setBusy('note');
    try {
      const { letter } = await api.note(item.key, note, on);
      onLetter(letter);
      setFlash(on ? 'Абзац добавлен' : 'Абзац убран');
    } catch (e) {
      onError(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  };

  const send = async (text = message) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setMessage('');
    setHistory((h) => [...h, { role: 'user', text: trimmed }]);
    setBusy('chat');
    try {
      const result = await api.chat(item.key, trimmed);
      setHistory(result.history);
      if (result.letter) {
        onLetter(result.letter);
        setFlash('Отклик обновлён');
      }
    } catch (e) {
      setHistory((h) => h.slice(0, -1));
      setMessage(trimmed);
      onError(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  };

  const hint = englishHint(item, board.englishLevel);
  const contact = board.contact;
  const phoneLocal = contact?.phone?.replace(/^\+?380\s*/, '');

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Header */}
      <header className="flex items-start gap-3 border-b border-slate-200 p-4">
        <ScoreBadge score={item.score} large />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg leading-snug font-semibold text-slate-900">{item.title}</h2>
          <p className="text-sm text-slate-500">
            {item.company ?? 'Компания не указана'} · {SECTION_LABEL[item.section]} · {longDay(item.day, board.today)}
          </p>
        </div>
        <button type="button" onClick={onClose} title="Закрыть (Esc)" className="-m-1 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
          <X className="size-5" />
        </button>
      </header>

      <div ref={body} className="flex-1 space-y-5 overflow-y-auto p-4">
        <Facts item={item} englishLevel={board.englishLevel} />

        {/* Claude's take */}
        {(item.summary || item.pros.length > 0 || item.cons.length > 0) && (
          <div className="space-y-2 rounded-xl bg-slate-50 p-3 text-sm">
            {item.summary && <p className="text-slate-700">{item.summary}</p>}
            {item.pros.length > 0 && (
              <ul className="space-y-0.5 text-emerald-800">
                {item.pros.map((p) => (
                  <li key={p}>+ {p}</li>
                ))}
              </ul>
            )}
            {item.cons.length > 0 && (
              <ul className="space-y-0.5 text-amber-800">
                {item.cons.map((c) => (
                  <li key={c}>− {c}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Contact fields for application forms */}
        {contact && (
          <div>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">Для формы</h3>
            <div className="flex flex-wrap gap-1.5 text-sm">
              <CopyButton text={contact.fullName} className="bg-slate-100 px-2.5 py-1.5 hover:bg-slate-200" />
              {contact.email && <CopyButton text={contact.email} className="bg-slate-100 px-2.5 py-1.5 hover:bg-slate-200" />}
              {contact.phone && phoneLocal && (
                <CopyButton text={phoneLocal} label="Без +380: код страны в формах выбирается отдельно" className="bg-slate-100 px-2.5 py-1.5 hover:bg-slate-200">
                  {contact.phone}
                </CopyButton>
              )}
            </div>
          </div>
        )}

        {/* Letter */}
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Отклик</h3>
            {item.letter && <span className="text-xs text-slate-400 tabular-nums">{item.letter.length} симв.</span>}
            {flash && <span className="text-xs font-medium text-emerald-600">{flash}</span>}
          </div>
          <div className={`relative rounded-xl ring-1 ring-slate-200 transition ${busy && busy !== 'note' ? 'opacity-50' : ''}`}>
            <p className="letter p-3.5 text-[15px] leading-relaxed text-slate-800">{item.letter ?? 'Отклика пока нет.'}</p>
            {busy && busy !== 'note' && (
              <div className="absolute inset-0 grid place-items-center">
                <Loader2 className="size-6 animate-spin text-slate-500" />
              </div>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.letter && (
              <CopyButton text={item.letter} className="bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700">
                Скопировать отклик
              </CopyButton>
            )}
            <button
              type="button"
              onClick={regenerate}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200 disabled:opacity-50"
            >
              <RefreshCw className={`size-4 ${busy === 'regen' ? 'animate-spin' : ''}`} /> Другой вариант
            </button>
          </div>

          {/* English: fixed paragraphs the candidate adds when they decide it's needed */}
          {item.letter && (
            <div className={`mt-3 rounded-xl p-3 ${hint ? 'bg-amber-50 ring-1 ring-amber-200' : 'bg-slate-50'}`}>
              <div className="mb-2 flex items-start gap-1.5 text-sm">
                <Languages className={`mt-0.5 size-4 shrink-0 ${hint ? 'text-amber-700' : 'text-slate-400'}`} />
                <span className={hint ? 'text-amber-900' : 'text-slate-500'}>
                  <span className="font-medium">Английский в отклике.</span> {hint ?? 'Требований не видно — обычно не нужно.'}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {NOTE_BUTTONS.map(({ note, label, hint: title }) => {
                  const on = item.notes.includes(note);
                  return (
                    <button
                      key={note}
                      type="button"
                      title={title}
                      aria-pressed={on}
                      disabled={busy !== null}
                      onClick={() => void toggleNote(note, !on)}
                      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
                        on ? 'bg-amber-600 text-white hover:bg-amber-700' : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      {on ? <Check className="size-4" /> : <span className="text-base leading-none">+</span>} {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Chat */}
        <div>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            <Sparkles className="size-3.5" /> Спросить или поправить отклик
          </h3>
          {history.length > 0 && (
            <div className="mb-2 space-y-2">
              {history.map((turn, i) => (
                <div
                  key={i}
                  className={`letter max-w-[90%] rounded-2xl px-3 py-2 text-sm ${
                    turn.role === 'user' ? 'ml-auto bg-sky-600 text-white' : 'bg-slate-100 text-slate-800'
                  }`}
                >
                  {turn.text.replace(/\n\[отклик обновлён\]$/, '')}
                  {turn.text.endsWith('[отклик обновлён]') && <span className="mt-1 block text-xs text-emerald-700">✓ отклик обновлён</span>}
                </div>
              ))}
              {busy === 'chat' && (
                <div className="inline-flex items-center gap-2 rounded-2xl bg-slate-100 px-3 py-2 text-sm text-slate-500">
                  <Loader2 className="size-4 animate-spin" /> Думаю…
                </div>
              )}
              <div ref={chatEnd} />
            </div>
          )}
          {history.length === 0 && (
            <div className="no-scrollbar mb-2 flex gap-1.5 overflow-x-auto">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => send(s)}
                  className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-600 hover:bg-slate-200 disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="flex items-end gap-2"
          >
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              placeholder="Например: убери второй абзац"
              className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border-0 bg-slate-100 px-3 py-2.5 text-[15px] ring-sky-500 outline-none focus:bg-white focus:ring-2"
            />
            <button
              type="submit"
              disabled={!message.trim() || busy !== null}
              className="grid size-10 shrink-0 place-items-center rounded-xl bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40"
            >
              <Send className="size-4" />
            </button>
          </form>
        </div>
      </div>

      {/* Sticky actions: reachable with a thumb on mobile */}
      <footer className="flex items-center gap-2 border-t border-slate-200 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl bg-slate-100 px-3 py-2.5 text-sm font-medium whitespace-nowrap text-slate-700 hover:bg-slate-200 sm:flex-1"
        >
          <ExternalLink className="size-4" /> На сайт
        </a>
        {item.decision === 'open' ? (
          <>
            <button
              type="button"
              onClick={() => onDecide('applied')}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-emerald-700"
            >
              <Check className="size-4" /> Откликнулся
            </button>
            <button
              type="button"
              onClick={() => onDecide('skipped')}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-500 hover:bg-slate-100"
            >
              <X className="size-4" /> <span className="whitespace-nowrap">Не интересно</span>
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => onDecide('open')}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-slate-100 px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-200"
          >
            <RotateCcw className="size-4" /> {item.decision === 'applied' ? 'Отклик отмечен · вернуть' : 'Пропущено · вернуть'}
          </button>
        )}
      </footer>
    </div>
  );
}
