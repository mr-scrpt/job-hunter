import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LlmUnavailableError } from '../../core/pipeline.ts';
import type { AssessInput, ChatInput, ChatReply, LetterInput, Llm } from '../../core/ports.ts';
import { AssessmentSchema, ChatReplySchema, LetterSchema, type Assessment } from '../../schemas/assessment.ts';
import type { Vacancy } from '../../schemas/vacancy.ts';

export interface ClaudeCliOptions {
  promptsDir: string;
  assessModel: string;
  letterModel: string;
  /** Model for the per-vacancy conversation; defaults to letterModel. */
  chatModel?: string;
  /** Binary name or path; resolved through PATH. */
  bin?: string;
  timeoutMs?: number;
}

const ResultEnvelope = z.object({
  is_error: z.boolean().optional(),
  subtype: z.string().optional(),
  result: z.string().optional(),
  api_error_status: z.number().nullable().optional(),
  structured_output: z.unknown().optional(),
});

// Text fragments meaning "retrying now is pointless" (usage cap, logged out, stuck OAuth refresh).
// These stop the run without burning per-vacancy attempts; the next run retries.
const UNAVAILABLE = /usage limit|rate limit|limit reached|log ?in|login|sign in|authenticat|oauth|credit balance|overloaded/i;

// Hard cap per vacancy description so one huge posting cannot blow the context/budget.
const DESCRIPTION_MAX = 12_000;

/**
 * Claude via the local `claude -p` CLI, billed to the logged-in subscription.
 * Runs isolated: no tools, no user settings/hooks/MCP, no session files.
 */
export class ClaudeCli implements Llm {
  readonly #opts: Required<ClaudeCliOptions>;
  readonly #assessSystem: string;
  readonly #letterSystem: string;
  readonly #chatSystem: string;
  // The CLI validates with a draft-07 validator and rejects the 2020-12 meta-schema URI.
  readonly #assessSchema = JSON.stringify(z.toJSONSchema(AssessmentSchema, { target: 'draft-7' }));
  readonly #letterSchema = JSON.stringify(z.toJSONSchema(LetterSchema, { target: 'draft-7' }));
  readonly #chatSchema = JSON.stringify(z.toJSONSchema(ChatReplySchema, { target: 'draft-7' }));

  constructor(options: ClaudeCliOptions) {
    this.#opts = { bin: 'claude', timeoutMs: 240_000, ...options, chatModel: options.chatModel ?? options.letterModel };
    this.#assessSystem = readFileSync(join(options.promptsDir, 'assess.md'), 'utf8');
    this.#letterSystem = readFileSync(join(options.promptsDir, 'letter.md'), 'utf8');
    this.#chatSystem = readFileSync(join(options.promptsDir, 'chat.md'), 'utf8');
  }

  async assess(input: AssessInput): Promise<Assessment> {
    const prompt = [
      section('Профиль кандидата', [
        `Уровень английского: ${input.englishLevel}. Максимум, который он потянет на собеседовании: ${input.englishMax}.`,
        input.preferences.trim(),
      ].join('\n')),
      section('Резюме', input.resume),
      section('Вакансия', renderVacancy(input.vacancy)),
    ].join('\n\n');
    const output = await this.#run(this.#opts.assessModel, this.#assessSystem, prompt, this.#assessSchema);
    return AssessmentSchema.parse(output);
  }

  async writeLetter(input: LetterInput): Promise<string> {
    const a = input.assessment;
    const parts = [
      section('Кандидат', input.candidateName),
      section('Резюме', input.resume),
      section('Вакансия', renderVacancy(input.vacancy)),
      // Only strengths: feeding the gaps in makes the model apologize for them in the letter.
      section('Разбор вакансии', [`Совпадения: ${a.pros.join('; ') || '—'}`, `AI-фокус: ${a.aiFocus}`].join('\n')),
    ];
    if (input.previousLetter) parts.push(section('Предыдущий вариант письма', input.previousLetter));
    if (input.feedback) parts.push(section('Что исправить (пожелание кандидата, приоритетно)', input.feedback));
    if (input.forbiddenTerms?.length) parts.push(forbiddenSection(input.forbiddenTerms));

    const output = await this.#run(this.#opts.letterModel, this.#letterSystem, parts.join('\n\n'), this.#letterSchema);
    return LetterSchema.parse(output).letter.trim();
  }

  async chat(input: ChatInput): Promise<ChatReply> {
    const a = input.assessment;
    const history = input.history.map((t) => `${t.role === 'user' ? 'Кандидат' : 'Асистент'}: ${t.text}`).join('\n\n');
    const parts = [
      section('Кандидат', input.candidateName),
      section('Резюме', input.resume),
      section('Вакансия', renderVacancy(input.vacancy)),
      section('Оценка', [`Балл: ${a.score}`, a.summary, `Плюсы: ${a.pros.join('; ') || '—'}`, `Минусы: ${a.cons.join('; ') || '—'}`].join('\n')),
      section('Текущий отклик', input.letter),
    ];
    if (history) parts.push(section('История разговора', history));
    if (input.forbiddenTerms?.length) parts.push(forbiddenSection(input.forbiddenTerms));
    parts.push(section('Новое сообщение кандидата', input.message));

    const output = await this.#run(this.#opts.chatModel, this.#chatSystem, parts.join('\n\n'), this.#chatSchema);
    const reply = ChatReplySchema.parse(output);
    return { reply: reply.reply.trim(), letter: reply.letter.trim() };
  }

  /** One retry on transient CLI failures; "unavailable" (limit, auth) fails fast. */
  async #run(model: string, system: string, prompt: string, schema: string): Promise<unknown> {
    try {
      return await this.#runOnce(model, system, prompt, schema);
    } catch (error) {
      if (error instanceof LlmUnavailableError) throw error;
      return this.#runOnce(model, system, prompt, schema);
    }
  }

  async #runOnce(model: string, system: string, prompt: string, schema: string): Promise<unknown> {
    const args = [
      '-p',
      '--model', model,
      '--system-prompt', system,
      '--tools', '',
      '--setting-sources', '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--output-format', 'json',
      '--json-schema', schema,
    ];
    const { stdout, stderr, code } = await runProcess(this.#opts.bin, args, prompt, this.#opts.timeoutMs);

    let envelope: z.infer<typeof ResultEnvelope> | undefined;
    try {
      envelope = ResultEnvelope.parse(JSON.parse(stdout));
    } catch {
      const detail = (stderr || stdout).trim().slice(0, 300) || `exit ${code}`;
      if (code === 127) throw new LlmUnavailableError(`claude CLI not found (${this.#opts.bin})`);
      throw UNAVAILABLE.test(detail) ? new LlmUnavailableError(detail) : new Error(`claude: ${detail}`);
    }

    if (envelope.is_error || code !== 0) {
      const detail = envelope.result ?? `exit ${code}: ${(stderr.trim() || stdout.trim()).slice(-400)}`;
      const status = envelope.api_error_status ?? 0;
      if (status === 401 || status === 429 || status === 529 || UNAVAILABLE.test(detail)) throw new LlmUnavailableError(detail);
      throw new Error(`claude: ${detail}`);
    }
    if (envelope.structured_output === undefined) throw new Error(`claude: no structured output (${envelope.subtype})`);
    return envelope.structured_output;
  }
}

const forbiddenSection = (terms: string[]): string =>
  section(
    'Заборонено згадувати',
    `Ці слова (і будь-які їхні форми) не можна вживати в листі: ${terms.join(', ')}.\n` +
      'Досвід, пов\u2019язаний з ними, описуй нейтрально, без назв компаній і без назви галузі ' +
      '(наприклад: «платформи з платіжними інтеграціями», «маркетингові лендінги для великих брендів»).',
  );

const section = (title: string, body: string): string => `<${tag(title)}>\n${body.trim()}\n</${tag(title)}>`;
const tag = (title: string): string => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_');

export function renderVacancy(v: Vacancy): string {
  const m = v.meta;
  const facts = [
    `Название: ${v.title}`,
    `Компания: ${v.company ?? 'не указана'}`,
    `Источник: ${v.source} (${v.url})`,
    m.salaryMinUsd || m.salaryMaxUsd ? `Зарплата: ${m.salaryMinUsd ?? '?'}–${m.salaryMaxUsd ?? '?'} USD/мес` : null,
    m.english ? `Английский по требованию: ${m.english}` : null,
    m.experienceYears !== undefined ? `Опыт: от ${m.experienceYears} лет` : null,
    m.remote !== undefined ? `Удалённо: ${m.remote ? 'да' : 'нет'}` : null,
    m.locations?.length ? `Локации: ${m.locations.join(', ')}` : null,
    m.domain ? `Домен: ${m.domain}` : null,
  ].filter(Boolean);
  const description = v.description.length > DESCRIPTION_MAX ? `${v.description.slice(0, DESCRIPTION_MAX)}\n[...обрезано]` : v.description;
  return `${facts.join('\n')}\n\nОписание:\n${description}`;
}

function runProcess(bin: string, args: string[], stdin: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGTERM' });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error: NodeJS.ErrnoException) =>
      resolve({ stdout, stderr: error.message, code: error.code === 'ENOENT' ? 127 : 1 }),
    );
    child.on('close', (code, signal) => resolve({ stdout, stderr: signal ? `${stderr}\nkilled by ${signal}` : stderr, code: code ?? 1 }));
    child.stdin.on('error', () => {}); // EPIPE if the CLI dies early; the close handler reports it
    child.stdin.end(stdin);
  });
}
