import { z } from 'zod';

export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export const CefrSchema = z.enum(CEFR_LEVELS);
export type Cefr = z.infer<typeof CefrSchema>;

export const cefrRank = (level: Cefr): number => CEFR_LEVELS.indexOf(level);

// Job boards sometimes type the level with Cyrillic look-alikes (В1 instead of B1).
const LOOKALIKES: Record<string, string> = { А: 'A', В: 'B', С: 'C' };

/** Extracts the first CEFR level mentioned in a text fragment. */
export function parseCefr(text: string): Cefr | undefined {
  const normalized = text.replace(/[АВС]/g, (ch) => LOOKALIKES[ch] ?? ch).toUpperCase();
  const match = /(?<![A-Z])([ABC][12])(?![0-9A-Z])/.exec(normalized);
  return match ? CefrSchema.parse(match[1]) : undefined;
}
