import { z } from 'zod';
import { CefrSchema } from './cefr.ts';

const QueryParams = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
export type QueryParams = z.infer<typeof QueryParams>;

const FeedSource = z.object({
  enabled: z.boolean().default(true),
  /** Query params shared by every feed of the source. */
  common: QueryParams.default({}),
  /** One RSS request per entry, merged over `common`. */
  feeds: z.array(QueryParams).min(1),
});
export type FeedSourceConfig = z.infer<typeof FeedSource>;

export const ProfileSchema = z.object({
  candidate: z.object({
    name: z.string().min(1),
    /** PDF (read via pdftotext) or plain text/markdown. `~` is expanded. */
    resumeFile: z.string().min(1),
    englishLevel: CefrSchema,
    /** Free text the model reads: what roles you want, what to avoid, priorities. */
    preferences: z.string().default(''),
  }),
  filters: z.object({
    /** Vacancies explicitly requiring a higher English level are dropped before the LLM. */
    englishMax: CefrSchema.default('B2'),
    /** Dropped when the published salary ceiling is below this (USD/month). 0 = off. */
    minSalaryUsd: z.number().int().nonnegative().default(0),
    remoteOnly: z.boolean().default(true),
    /** Whole-word, case-insensitive matches against the vacancy title. */
    titleStopWords: z.array(z.string()).default([]),
    /** Case-insensitive substring matches against the company name. */
    excludeCompanies: z.array(z.string()).default([]),
    maxAgeDays: z.number().positive().default(3),
  }),
  scoring: z.object({
    /** Minimum score (0-100) for a vacancy to get a letter and a Telegram card. */
    notifyThreshold: z.number().min(0).max(100).default(65),
    /** LLM budget per scan run; the rest waits for the next run. */
    maxAssessPerRun: z.number().int().positive().default(25),
    assessModel: z.string().default('sonnet'),
    letterModel: z.string().default('sonnet'),
  }),
  sources: z.object({
    djinni: FeedSource,
    dou: FeedSource,
  }),
  bot: z
    .object({
      /** How often the bot process runs a scan on its own. 0 = only on /scan. */
      scanIntervalMinutes: z.number().nonnegative().default(30),
      /** No automatic scans in this local-time window, e.g. "23-8". Empty = always. */
      quietHours: z
        .string()
        .regex(/^(\d{1,2})-(\d{1,2})$/)
        .or(z.literal(''))
        .default('23-8'),
    })
    .default({ scanIntervalMinutes: 30, quietHours: '23-8' }),
});

export type Profile = z.infer<typeof ProfileSchema>;
