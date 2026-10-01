import { parseCefr, type Cefr } from '../schemas/cefr.ts';

// Word levels used in postings, most specific first ("upper-intermediate" before "intermediate").
const WORD_LEVELS: ReadonlyArray<[RegExp, Cefr]> = [
  [/upper[\s-]*intermediate|вище середнього|выше среднего/i, 'B2'],
  [/pre[\s-]*intermediate|нижче середнього|ниже среднего/i, 'A2'],
  [/intermediate|середній|средний/i, 'B1'],
  [/advanced|fluent|вільн|просунут|свободн/i, 'C1'],
  [/elementary|beginner|basic|базов|початков/i, 'A1'],
];

const ENGLISH_MENTION = /english|англійськ|английск/gi;

/**
 * Finds an English requirement stated near the word "English"/"Англійська".
 * Only looks at a short window after each mention so unrelated "B2B" or "Advanced React"
 * elsewhere in the text cannot leak in. Returns the strictest level mentioned.
 */
export function parseEnglishRequirement(text: string): Cefr | undefined {
  let strictest: Cefr | undefined;
  for (const mention of text.matchAll(ENGLISH_MENTION)) {
    const start = mention.index ?? 0;
    const window = text.slice(Math.max(0, start - 25), start + mention[0].length + 40);
    const level = parseCefr(window) ?? WORD_LEVELS.find(([re]) => re.test(window))?.[1];
    if (level && (!strictest || level > strictest)) strictest = level;
  }
  return strictest;
}
