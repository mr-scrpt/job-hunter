import { checkedChat, writeCheckedLetter } from './letter.ts';
import type { ChatTurn, Llm, Store, StoredVacancy } from './ports.ts';
import type { Decision } from './board.ts';

/**
 * What the user can do with one vacancy, independent of the UI (web app, bot).
 * Throws ActionError with a user-facing (Russian) message on bad input.
 */

export class ActionError extends Error {
  override readonly name = 'ActionError';
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

export interface Workbench {
  store: Store;
  llm: Llm;
  resume: string;
  candidateName: string;
  neverMention: string[];
}

const HISTORY_TURNS = 10;

const STATUS_FOR: Record<Decision, StoredVacancy['status']> = { open: 'notified', applied: 'applied', skipped: 'skipped' };
const EVENT_FOR: Record<Decision, string> = { open: 'reopened', applied: 'applied', skipped: 'skipped' };

function load(store: Store, key: string): StoredVacancy {
  const vacancy = store.get(key);
  if (!vacancy) throw new ActionError('Вакансия не найдена', 404);
  return vacancy;
}

function assessed(vacancy: StoredVacancy): StoredVacancy & { assessment: NonNullable<StoredVacancy['assessment']> } {
  if (!vacancy.assessment) throw new ActionError('Вакансия ещё не оценена', 409);
  return vacancy as StoredVacancy & { assessment: NonNullable<StoredVacancy['assessment']> };
}

export function decide(store: Store, key: string, decision: Decision): StoredVacancy {
  const vacancy = load(store, key);
  if (!['ready', 'notified', 'applied', 'skipped'].includes(vacancy.status))
    throw new ActionError('Эту вакансию нельзя отметить', 409);
  store.update(key, { status: STATUS_FOR[decision] });
  store.log(EVENT_FOR[decision], key);
  return load(store, key);
}

/** A different take on the letter under the same constraints. */
export async function regenerateLetter(wb: Workbench, key: string): Promise<string> {
  const vacancy = assessed(load(wb.store, key));
  const letter = await writeCheckedLetter(
    wb.llm,
    {
      vacancy,
      resume: wb.resume,
      candidateName: wb.candidateName,
      assessment: vacancy.assessment,
      previousLetter: vacancy.letter ?? undefined,
      feedback: 'Напиши інший варіант: інша структура і формулювання, інші акценти з резюме. Обсяг і правила ті самі.',
    },
    wb.neverMention,
  );
  wb.store.update(key, { letter });
  wb.store.log('regenerated', key);
  return letter;
}

export interface ChatOutcome {
  reply: string;
  /** New letter when the message asked for a change. */
  letter: string | null;
  history: ChatTurn[];
}

/** One message about the vacancy: edits the letter ("короче") or answers a question ("что за компания?"). */
export async function chatAboutVacancy(wb: Workbench, key: string, message: string): Promise<ChatOutcome> {
  const text = message.trim();
  if (!text) throw new ActionError('Пустое сообщение');
  const vacancy = assessed(load(wb.store, key));
  if (!vacancy.letter) throw new ActionError('У вакансии ещё нет отклика', 409);

  const result = await checkedChat(
    wb.llm,
    {
      vacancy,
      resume: wb.resume,
      candidateName: wb.candidateName,
      assessment: vacancy.assessment,
      letter: vacancy.letter,
      history: wb.store.recentChat(key, HISTORY_TURNS),
      message: text,
    },
    wb.neverMention,
  );

  wb.store.addChatTurn(key, { role: 'user', text });
  wb.store.addChatTurn(key, { role: 'assistant', text: result.letter ? `${result.reply}\n[отклик обновлён]` : result.reply });
  if (result.letter) {
    wb.store.update(key, { letter: result.letter });
    wb.store.log('chat_edit', key, { message: text });
  } else {
    wb.store.log('chat_answer', key, { message: text });
  }
  return { reply: result.reply, letter: result.letter || null, history: wb.store.recentChat(key, 50) };
}

/** Prevents two Claude jobs on the same vacancy at once (double taps, two tabs). */
export class KeyedLock {
  readonly #busy = new Set<string>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.#busy.has(key)) throw new ActionError('Уже работаю над этой вакансией, подожди', 409);
    this.#busy.add(key);
    try {
      return await work();
    } finally {
      this.#busy.delete(key);
    }
  }
}
