import { Bot, GrammyError, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { decodeCallback, encodeCallback, renderCard, type Card, type CardAction } from '../../core/card.ts';
import type { Llm, Notifier, Store, StoredVacancy } from '../../core/ports.ts';

export const CHAT_KV = 'tg_chat_id';
const REWRITE_KV = 'tg_pending_rewrite';

const toKeyboard = (card: Card, key: string): InlineKeyboardButton[][] =>
  card.rows.map((row) =>
    row.map((b): InlineKeyboardButton =>
      b.kind === 'url' ? { text: b.label, url: b.url } : { text: b.label, callback_data: encodeCallback(b.action, key) },
    ),
  );

const messageOptions = (card: Card, key: string) => ({
  parse_mode: 'HTML' as const,
  link_preview_options: { is_disabled: true },
  reply_markup: { inline_keyboard: toKeyboard(card, key) },
});

/** Sends cards to the chat bound with /start. Used by the scan process (no polling). */
export class TelegramNotifier implements Notifier {
  readonly #bot: Bot;
  readonly #store: Store;

  constructor(token: string, store: Store) {
    this.#bot = new Bot(token);
    this.#store = store;
  }

  async sendCard(vacancy: StoredVacancy): Promise<number | undefined> {
    const chatId = this.#store.getKv(CHAT_KV);
    if (!chatId) return undefined;
    const card = renderCard({ ...vacancy, status: 'notified' });
    const message = await this.#bot.api.sendMessage(chatId, card.html, messageOptions(card, vacancy.key));
    return message.message_id;
  }
}

/** Notifier used when no token is configured: cards stay queued as `ready`. */
export const disabledNotifier: Notifier = { sendCard: async () => undefined };

export interface BotDeps {
  token: string;
  store: Store;
  llm: Llm;
  candidateName: string;
  resume: string;
  /** Triggers a scan in-process; returns a human summary. */
  scan: () => Promise<string>;
  stats: () => string;
  /** Called once when the owner chat is bound via /start (e.g. to flush queued cards). */
  onBound?: () => Promise<unknown>;
  log?: (message: string) => void;
}

const STATUS_FOR: Record<Exclude<CardAction, 'rewrite'>, StoredVacancy['status']> = {
  applied: 'applied',
  skip: 'skipped',
  undo: 'notified',
};

const EVENT_FOR: Record<Exclude<CardAction, 'rewrite'>, string> = {
  applied: 'applied',
  skip: 'skipped',
  undo: 'reopened',
};

const HELP = [
  'Я присылаю подходящие вакансии с Djinni и DOU вместе с готовым откликом.',
  '',
  'Кнопки на карточке:',
  '✅ Отправил — отметить, что откликнулся',
  '✏️ Переписать — напиши, что поменять в письме',
  '⏭ Пропустить — убрать из списка',
  '',
  'Команды:',
  '/scan — проверить вакансии сейчас',
  '/stats — статистика',
].join('\n');

export function createBot(deps: BotDeps): Bot {
  const { store, llm } = deps;
  const log = deps.log ?? (() => {});
  const bot = new Bot(deps.token);

  // Owner guard: the first chat that sends /start owns the bot; everyone else is ignored.
  bot.use(async (ctx, next) => {
    const owner = store.getKv(CHAT_KV);
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    let justBound = false;
    if (!owner) {
      if (ctx.message?.text?.startsWith('/start')) {
        store.setKv(CHAT_KV, String(chatId));
        store.log('tg_bound', null, { chatId });
        log(`bound to chat ${chatId}`);
        justBound = true;
      } else return;
    } else if (owner !== String(chatId)) {
      log(`ignored update from foreign chat ${chatId}`);
      return;
    }
    await next();
    if (justBound) await deps.onBound?.().catch((error: unknown) => log(`onBound failed: ${String(error)}`));
  });

  bot.command(['start', 'help'], (ctx) => ctx.reply(HELP));

  let scanning = false;
  bot.command('scan', async (ctx) => {
    if (scanning) return void (await ctx.reply('Уже проверяю, подожди.'));
    scanning = true;
    await ctx.reply('Проверяю вакансии… Это займёт пару минут.');
    // Run detached so grammY keeps processing other updates (buttons) meanwhile.
    void deps
      .scan()
      .then((summary) => ctx.reply(summary))
      .catch((error: unknown) => ctx.reply(`Проверка упала: ${String(error)}`))
      .finally(() => (scanning = false));
  });

  bot.command('stats', (ctx) => ctx.reply(deps.stats()));

  bot.command('cancel', async (ctx) => {
    store.setKv(REWRITE_KV, '');
    await ctx.reply('Ок, отменил.');
  });

  bot.on('callback_query:data', async (ctx) => {
    const parsed = decodeCallback(ctx.callbackQuery.data);
    const vacancy = parsed && store.get(parsed.key);
    if (!parsed || !vacancy) return void (await ctx.answerCallbackQuery({ text: 'Вакансия не найдена' }));

    if (parsed.action === 'rewrite') {
      store.setKv(REWRITE_KV, vacancy.key);
      await ctx.answerCallbackQuery();
      await ctx.reply(`Что поменять в отклике на «${vacancy.title}»? Напиши пожелание или «-», чтобы просто сгенерировать заново. /cancel — отмена.`, {
        reply_markup: { force_reply: true, input_field_placeholder: 'Например: короче, сделай акцент на NestJS' },
      });
      return;
    }

    const status = STATUS_FOR[parsed.action];
    store.update(vacancy.key, { status });
    store.log(EVENT_FOR[parsed.action], vacancy.key);
    await refreshCard(ctx, { ...vacancy, status });
    await ctx.answerCallbackQuery({ text: parsed.action === 'applied' ? 'Отмечено ✅' : parsed.action === 'skip' ? 'Пропущено' : 'Вернул' });
  });

  bot.on('message:text', async (ctx) => {
    const key = store.getKv(REWRITE_KV);
    const vacancy = key ? store.get(key) : undefined;
    if (!vacancy?.assessment) return void (await ctx.reply('Не понял. /help — что я умею.'));

    store.setKv(REWRITE_KV, '');
    const feedback = ctx.message.text.trim();
    await ctx.reply('Переписываю…');
    try {
      const letter = await llm.writeLetter({
        vacancy,
        resume: deps.resume,
        candidateName: deps.candidateName,
        assessment: vacancy.assessment,
        previousLetter: vacancy.letter ?? undefined,
        feedback: feedback === '-' ? undefined : feedback,
      });
      store.update(vacancy.key, { letter });
      store.log('rewritten', vacancy.key, { feedback });
      const updated = { ...vacancy, letter };
      const card = renderCard(updated);
      // A fresh card is easier to find than an edit far up in the chat; the old one is marked replaced.
      const sent = await ctx.reply(card.html, messageOptions(card, vacancy.key));
      if (vacancy.tgMessageId) {
        await ctx.api
          .editMessageText(ctx.chat.id, vacancy.tgMessageId, `⤵️ <s>${vacancy.title.replace(/[<&>]/g, '')}</s> — переписано ниже`, { parse_mode: 'HTML' })
          .catch(() => {});
      }
      store.update(vacancy.key, { tgMessageId: sent.message_id });
    } catch (error) {
      log(`rewrite failed ${vacancy.key} — ${String(error)}`);
      await ctx.reply(`Не получилось переписать: ${String(error).slice(0, 300)}`);
    }
  });

  bot.catch((err) => log(`bot error: ${err.message}`));
  return bot;
}

async function refreshCard(ctx: Context, vacancy: StoredVacancy): Promise<void> {
  const card = renderCard(vacancy);
  try {
    await ctx.editMessageText(card.html, messageOptions(card, vacancy.key));
  } catch (error) {
    if (!(error instanceof GrammyError && error.description.includes('message is not modified'))) throw error;
  }
}
