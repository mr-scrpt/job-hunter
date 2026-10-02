import { Bot } from 'grammy';
import { sectionBreakdown, type BoardItem } from '../../core/board.ts';
import type { Notifier, Store, StoredVacancy } from '../../core/ports.ts';
import { escapeHtml, plural } from '../../core/text.ts';

export const CHAT_KV = 'tg_chat_id';

/**
 * Telegram is notification-only: one short message per batch of new vacancies, with a link to the web board.
 * Reviewing, letters and the AI chat live in the web app.
 */
export class TelegramNotifier implements Notifier {
  readonly #bot: Bot;
  readonly #store: Store;
  readonly #boardUrl: string;

  constructor(bot: Bot, store: Store, boardUrl: string) {
    this.#bot = bot;
    this.#store = store;
    this.#boardUrl = boardUrl;
  }

  get chatId(): string | undefined {
    return this.#store.getKv(CHAT_KV) || undefined;
  }

  async announce(fresh: StoredVacancy[]): Promise<boolean> {
    const chatId = this.chatId;
    // Not bound yet: the vacancies are on the board anyway, nothing to retry.
    if (!chatId) return true;
    await this.#bot.api.sendMessage(chatId, announcementHtml(fresh, this.#boardUrl), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: openButton(this.#boardUrl),
    });
    return true;
  }

  async refresh(note: string): Promise<void> {
    const chatId = this.chatId;
    if (chatId) await this.#bot.api.sendMessage(chatId, escapeHtml(note), { parse_mode: 'HTML' });
  }
}

/** Used when no bot token is configured: vacancies still reach the board. */
export const silentNotifier = { announce: async () => true };

const TOP_IN_MESSAGE = 3;

/** Inline-keyboard button to the board; Telegram refuses non-https/LAN URLs in buttons, so it's optional. */
function openButton(boardUrl: string): { inline_keyboard: Array<Array<{ text: string; url: string }>> } | undefined {
  return /^https?:\/\//.test(boardUrl) ? { inline_keyboard: [[{ text: '📋 Открыть вакансии', url: boardUrl }]] } : undefined;
}

/** "🔔 3 новые вакансии · Fullstack 2 · Backend 1", the best few by score, and the board link. */
export function announcementHtml(
  fresh: Array<Pick<StoredVacancy, 'title' | 'company' | 'score' | 'assessment'>>,
  boardUrl: string,
): string {
  const sections = fresh.map((v): Pick<BoardItem, 'section'> => ({ section: v.assessment?.role ?? 'other' }));
  const head = `🔔 <b>${fresh.length} ${plural(fresh.length, ['новая вакансия', 'новые вакансии', 'новых вакансий'])}</b> · ${sectionBreakdown(sections)}`;
  const top = [...fresh]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, TOP_IN_MESSAGE)
    .map((v) => `• ${escapeHtml(v.title)}${v.company ? ` — ${escapeHtml(v.company)}` : ''} · ${v.score ?? '?'}`);
  const more = fresh.length > TOP_IN_MESSAGE ? [`…и ещё ${fresh.length - TOP_IN_MESSAGE}`] : [];
  return [head, '', ...top, ...more, '', escapeHtml(boardUrl)].join('\n');
}

export interface BotDeps {
  bot: Bot;
  store: Store;
  boardUrl: string;
  /** Runs a scan in-process; returns a human summary. */
  scan: () => Promise<string>;
  stats: () => string;
  log?: (message: string) => void;
}

const help = (boardUrl: string): string =>
  [
    'Я слежу за вакансиями на Djinni, DOU и Robota.ua и сообщаю о новых подходящих.',
    '',
    'Разбирать вакансии, править отклики и отмечать отправленные — в веб-приложении:',
    boardUrl,
    '',
    '/open — ссылка на вакансии',
    '/scan — проверить вакансии сейчас',
    '/stats — статистика',
  ].join('\n');

/** Owner-only bot: /start binds the chat; the rest are commands. */
export function createBot({ bot, store, boardUrl, scan, stats, log = () => {} }: BotDeps): Bot {
  bot.use(async (ctx, next) => {
    const owner = store.getKv(CHAT_KV);
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!owner) {
      if (!ctx.message?.text?.startsWith('/start')) return;
      store.setKv(CHAT_KV, String(chatId));
      store.log('tg_bound', null, { chatId });
      log(`bound to chat ${chatId}`);
    } else if (owner !== String(chatId)) {
      log(`ignored update from foreign chat ${chatId}`);
      return;
    }
    await next();
  });

  const linkReply = { link_preview_options: { is_disabled: true }, reply_markup: openButton(boardUrl) };

  bot.command(['start', 'help'], (ctx) => ctx.reply(help(boardUrl), linkReply));
  bot.command(['open', 'list'], (ctx) => ctx.reply(`Вакансии: ${boardUrl}`, linkReply));
  bot.command('stats', (ctx) => ctx.reply(stats()));

  let scanning = false;
  bot.command('scan', async (ctx) => {
    if (scanning) return void (await ctx.reply('Уже проверяю, подожди.'));
    scanning = true;
    const status = await ctx.reply('Проверяю вакансии… Это займёт пару минут.');
    void scan()
      .then((summary) => ctx.api.editMessageText(ctx.chat.id, status.message_id, summary))
      .catch((error: unknown) => ctx.reply(`Проверка упала: ${String(error)}`))
      .finally(() => (scanning = false));
  });

  // Buttons on old deck messages from the previous version.
  bot.on('callback_query:data', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Вакансии теперь в веб-приложении' });
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply(`Вакансии теперь разбираются в веб-приложении: ${boardUrl}`, linkReply);
  });

  bot.on('message:text', (ctx) =>
    ctx.reply(`Отклики правятся в веб-приложении, в карточке вакансии; ссылку на вакансию тоже можно добавить там: ${boardUrl}`, linkReply),
  );

  bot.catch((err) => log(`bot error: ${err.message}`));
  return bot;
}
