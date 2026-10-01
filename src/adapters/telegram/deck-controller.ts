import { GrammyError, type Api } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { anchor, encodeDeckCallback, orderQueue, renderDeck, step, type DeckState, type DeckView } from '../../core/deck.ts';
import type { Notifier, Store, StoredVacancy } from '../../core/ports.ts';
import { announcement } from '../../core/deck.ts';

export const CHAT_KV = 'tg_chat_id';
const DECK_MSG = 'deck_msg';
const DECK_FOCUS = 'deck_focus';
const DECK_INDEX = 'deck_index';

export interface ShowOptions {
  /** One-off line at the top (what just happened). */
  note?: string;
  /** Replaces the chat hint while a long operation runs. */
  busy?: string;
  /** Delete the current deck and post a fresh one at the bottom of the chat. */
  repost?: boolean;
}

const isNotModified = (error: unknown): boolean =>
  error instanceof GrammyError && error.description.includes('message is not modified');

const keyboard = (view: DeckView): InlineKeyboardButton[][] =>
  view.rows.map((row) =>
    row.map((b): InlineKeyboardButton => (b.kind === 'url' ? { text: b.label, url: b.url } : { text: b.label, callback_data: encodeDeckCallback(b.action) })),
  );

/**
 * The single live "deck" message: the review queue shown one vacancy at a time.
 * State (message id, focused vacancy, position) lives in the store so the bot and a CLI scan share it.
 */
export class DeckController {
  readonly #api: Api;
  readonly #store: Store;

  constructor(api: Api, store: Store) {
    this.#api = api;
    this.#store = store;
  }

  get chatId(): string | undefined {
    return this.#store.getKv(CHAT_KV) || undefined;
  }

  get deckId(): number | undefined {
    const id = Number(this.#store.getKv(DECK_MSG));
    return id > 0 ? id : undefined;
  }

  queue(): StoredVacancy[] {
    return orderQueue(this.#store.listByStatus(['notified']));
  }

  state(): DeckState {
    const queue = this.queue();
    const index = anchor(queue, this.#store.getKv(DECK_FOCUS) || null, Number(this.#store.getKv(DECK_INDEX) ?? 0));
    return { queue, index };
  }

  focus(): StoredVacancy | undefined {
    const { queue, index } = this.state();
    return queue[index];
  }

  setFocus(key: string): void {
    this.#store.setKv(DECK_FOCUS, key);
  }

  move(delta: -1 | 1): void {
    const state = this.state();
    const index = step(state, delta);
    this.#save(state.queue[index]?.key ?? null, index);
  }

  /** Renders the deck; edits in place unless `repost` is set or the old message can't be edited. */
  async show(opts: ShowOptions = {}): Promise<boolean> {
    const chatId = this.chatId;
    if (!chatId) return false;

    const state = this.state();
    const view = renderDeck(state, opts);
    this.#save(view.focusKey, state.index);
    const markup = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: keyboard(view) } };

    const current = this.deckId;
    if (current && !opts.repost) {
      try {
        await this.#api.editMessageText(chatId, current, view.html, markup);
        return true;
      } catch (error) {
        if (isNotModified(error)) return true;
        // Deleted by the user or too old to edit: fall through and post a new one.
      }
    }

    const sent = await this.#api.sendMessage(chatId, view.html, markup);
    this.#store.setKv(DECK_MSG, String(sent.message_id));
    if (current && current !== sent.message_id) await this.#api.deleteMessage(chatId, current).catch(() => {});
    return true;
  }

  #save(focusKey: string | null, index: number): void {
    this.#store.setKv(DECK_FOCUS, focusKey ?? '');
    this.#store.setKv(DECK_INDEX, String(index));
  }
}

/** Announces new vacancies by re-posting the deck at the bottom with a note (one message per batch). */
export class TelegramNotifier implements Notifier {
  readonly deck: DeckController;

  constructor(deck: DeckController) {
    this.deck = deck;
  }

  async announce(fresh: StoredVacancy[]): Promise<boolean> {
    if (!this.deck.chatId) return false;
    return this.deck.show({ repost: true, note: announcement(fresh.length, this.deck.queue().length) });
  }
}

/** Notifier used when no token is configured: vacancies stay queued as `ready`. */
export const disabledNotifier: Notifier = { announce: async () => false };
