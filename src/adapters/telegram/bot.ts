import { Bot } from 'grammy';
import { decodeDeckCallback, type DeckAction } from '../../core/deck.ts';
import { checkedChat, writeCheckedLetter } from '../../core/letter.ts';
import type { Llm, Store, StoredVacancy } from '../../core/ports.ts';
import { escapeHtml } from '../../core/text.ts';
import { CHAT_KV, type DeckController } from './deck-controller.ts';

export { CHAT_KV, DeckController, disabledNotifier, TelegramNotifier } from './deck-controller.ts';

export interface BotDeps {
  bot: Bot;
  deck: DeckController;
  store: Store;
  llm: Llm;
  candidateName: string;
  neverMention: string[];
  resume: string;
  /** Triggers a scan in-process; returns a human summary. */
  scan: () => Promise<string>;
  stats: () => string;
  /** Fetches, assesses and queues a vacancy from a pasted link. */
  addFromUrl: (url: string) => Promise<StoredVacancy>;
  /** Called once when the owner chat is bound via /start (e.g. to flush queued vacancies). */
  onBound?: () => Promise<unknown>;
  log?: (message: string) => void;
}

const HISTORY_TURNS = 10;
const URL_RE =
  /https?:\/\/(?:www\.)?(?:djinni\.co\/jobs\/\d+|jobs\.dou\.ua\/companies\/[^\s/]+\/vacancies\/\d+|(?:robota|rabota)\.ua\/(?:[a-z]{2}\/)?(?:company\d+\/)?vacancy\d+)\S*/i;

const HELP = [
  'Я подбираю вакансии с Djinni, DOU и Robota.ua и готовлю отклики.',
  '',
  'Все вакансии на разбор — в одном сообщении: ◀️ ▶️ листают, ✅ Отправил и ⏭ Пропустить убирают текущую из очереди.',
  '',
  'Пока открыта вакансия, просто пиши в чат:',
  '• «короче», «добавь про NestJS», «убери абзац про безопасность» — перепишу отклик;',
  '• «что за компания?», «стоит ли откликаться?» — отвечу по вакансии.',
  '',
  'Прислал ссылку на вакансию Djinni, DOU или Robota.ua — разберу её и напишу отклик.',
  '',
  '/list — показать очередь внизу чата',
  '/scan — проверить вакансии сейчас',
  '/stats — статистика',
].join('\n');

export function createBot(deps: BotDeps): Bot {
  const { bot, deck, store, llm } = deps;
  const log = deps.log ?? (() => {});

  // Owner guard: the first chat that sends /start owns the bot; everyone else is ignored.
  bot.use(async (ctx, next) => {
    const owner = store.getKv(CHAT_KV);
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    let justBound = false;
    if (!owner) {
      if (!ctx.message?.text?.startsWith('/start')) return;
      store.setKv(CHAT_KV, String(chatId));
      store.log('tg_bound', null, { chatId });
      log(`bound to chat ${chatId}`);
      justBound = true;
    } else if (owner !== String(chatId)) {
      log(`ignored update from foreign chat ${chatId}`);
      return;
    }
    await next();
    if (justBound) await deps.onBound?.().catch((error: unknown) => log(`onBound failed: ${String(error)}`));
  });

  // Claude calls take 10-40 s; one at a time keeps the deck consistent and the subscription calm.
  let busy = false;
  const exclusive = async (label: string, work: () => Promise<void>): Promise<boolean> => {
    if (busy) return false;
    busy = true;
    try {
      await work();
    } catch (error) {
      log(`${label} failed — ${String(error)}`);
      await deck.show({ note: `Не получилось: ${String(error).slice(0, 200)}` }).catch(() => {});
    } finally {
      busy = false;
    }
    return true;
  };

  bot.command(['start', 'help'], async (ctx) => {
    await ctx.reply(HELP);
    await deck.show({ repost: true });
  });

  bot.command('list', async () => {
    await deck.show({ repost: true });
  });

  let scanning = false;
  bot.command('scan', async (ctx) => {
    if (scanning) return void (await ctx.reply('Уже проверяю, подожди.'));
    scanning = true;
    const status = await ctx.reply('Проверяю вакансии… Это займёт пару минут.');
    // Detached so buttons and chat keep working meanwhile; new vacancies re-post the deck themselves.
    void deps
      .scan()
      .then((summary) => ctx.api.editMessageText(ctx.chat.id, status.message_id, summary))
      .catch((error: unknown) => ctx.reply(`Проверка упала: ${String(error)}`))
      .finally(() => (scanning = false));
  });

  bot.command('stats', (ctx) => ctx.reply(deps.stats()));

  bot.on('callback_query:data', async (ctx) => {
    const action = decodeDeckCallback(ctx.callbackQuery.data);
    const messageId = ctx.callbackQuery.message?.message_id;

    // Buttons on an old deck or on the old per-vacancy cards just bring the live deck down here.
    if (!action || messageId !== deck.deckId) {
      await ctx.answerCallbackQuery({ text: 'Открываю актуальный список' });
      await ctx.deleteMessage().catch(() => {});
      await deck.show({ repost: true });
      return;
    }
    await handleAction(action, (text) => ctx.answerCallbackQuery(text ? { text } : undefined));
  });

  async function handleAction(action: DeckAction, answer: (text?: string) => Promise<unknown>): Promise<void> {
    if (action === 'prev' || action === 'next') {
      deck.move(action === 'prev' ? -1 : 1);
      await answer();
      await deck.show();
      return;
    }
    if (action === 'refresh') {
      await answer();
      await deck.show();
      return;
    }

    const vacancy = deck.focus();
    if (!vacancy) return void (await answer('Очередь пуста'));

    if (action === 'applied' || action === 'skip') {
      const status = action === 'applied' ? 'applied' : 'skipped';
      store.update(vacancy.key, { status });
      store.log(status, vacancy.key);
      await answer(action === 'applied' ? 'Отмечено ✅' : 'Пропущено');
      await deck.show({ note: `${action === 'applied' ? '✅ Отправлено' : '⏭ Пропущено'}: ${vacancy.title}` });
      return;
    }

    // regen: a different take on the letter under the same constraints.
    const assessment = vacancy.assessment;
    if (!assessment) return void (await answer('Нет оценки для этой вакансии'));
    const started = await exclusive('regen', async () => {
      await answer('Пишу другой вариант…');
      await deck.show({ busy: 'Пишу другой вариант отклика…' });
      const letter = await writeCheckedLetter(
        llm,
        {
          vacancy,
          resume: deps.resume,
          candidateName: deps.candidateName,
          assessment,
          previousLetter: vacancy.letter ?? undefined,
          feedback: 'Напиши інший варіант: інша структура і формулювання, інші акценти з резюме. Обсяг і правила ті самі.',
        },
        deps.neverMention,
      );
      store.update(vacancy.key, { letter });
      store.log('regenerated', vacancy.key);
      deck.setFocus(vacancy.key);
      await deck.show({ note: 'Новый вариант отклика готов.' });
    });
    if (!started) await answer('Подожди, ещё работаю над предыдущим запросом');
  }

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return void (await ctx.reply('Не знаю такой команды. /help — что я умею.'));

    const url = URL_RE.exec(text)?.[0];
    if (url) {
      const started = await exclusive('add-url', async () => {
        await deck.show({ repost: true, busy: 'Читаю вакансию по ссылке, оцениваю и пишу отклик… (~1 мин)' });
        const vacancy = await deps.addFromUrl(url);
        deck.setFocus(vacancy.key);
        await deck.show({ note: `Добавил: ${vacancy.title}` });
      });
      if (!started) await ctx.reply('Подожди, ещё работаю над предыдущим запросом.');
      return;
    }

    const vacancy = deck.focus();
    const assessment = vacancy?.assessment;
    const letter = vacancy?.letter;
    if (!vacancy || !assessment || !letter) {
      return void (await ctx.reply('Сейчас нет открытой вакансии. Пришли ссылку на вакансию Djinni/DOU/Robota.ua или дождись новых.'));
    }

    const started = await exclusive('chat', async () => {
      // The user's message stays above; the deck moves to the bottom with the result.
      await deck.show({ repost: true, busy: 'Думаю…' });
      const result = await checkedChat(
        llm,
        {
          vacancy,
          resume: deps.resume,
          candidateName: deps.candidateName,
          assessment,
          letter,
          history: store.recentChat(vacancy.key, HISTORY_TURNS),
          message: text,
        },
        deps.neverMention,
      );
      store.addChatTurn(vacancy.key, { role: 'user', text });
      store.addChatTurn(vacancy.key, { role: 'assistant', text: result.letter ? `${result.reply}\n[отклик обновлён]` : result.reply });
      deck.setFocus(vacancy.key);

      if (result.letter) {
        store.update(vacancy.key, { letter: result.letter });
        store.log('chat_edit', vacancy.key, { message: text });
        await deck.show({ note: result.reply });
      } else {
        store.log('chat_answer', vacancy.key, { message: text });
        // An answer stays in the history as its own message, with the deck re-posted under it.
        await ctx.reply(`💬 <b>${escapeHtml(vacancy.title)}</b>\n\n${escapeHtml(result.reply)}`, { parse_mode: 'HTML' });
        await deck.show({ repost: true });
      }
    });
    if (!started) await ctx.reply('Подожди, ещё работаю над предыдущим запросом.');
  });

  bot.catch((err) => log(`bot error: ${err.message}`));
  return bot;
}
