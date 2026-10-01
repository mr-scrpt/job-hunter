import type { Llm, LetterInput } from './ports.ts';

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Terms from `terms` that occur in `text`. Matches at a word start, case-insensitively, so
 * inflected forms count ("факторинг" catches "факторингу") but substrings inside words don't ("Corp" ≠ "Incorporated").
 */
export function findForbiddenTerms(text: string, terms: readonly string[]): string[] {
  return terms.filter((term) => term.trim() && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(term.trim())}`, 'iu').test(text));
}

export class ForbiddenTermsError extends Error {
  override readonly name = 'ForbiddenTermsError';
  readonly terms: string[];
  constructor(terms: string[]) {
    super(`letter still mentions forbidden terms: ${terms.join(', ')}`);
    this.terms = terms;
  }
}

const MAX_FIXES = 2;

/**
 * Writes a letter and guarantees none of `forbiddenTerms` leaks into it: the model gets the list up front,
 * and any slip is sent back for a targeted fix. Throws rather than return a letter that still leaks.
 */
export async function writeCheckedLetter(llm: Llm, input: LetterInput, forbiddenTerms: readonly string[]): Promise<string> {
  const base: LetterInput = { ...input, forbiddenTerms: [...forbiddenTerms] };
  let letter = await llm.writeLetter(base);

  for (let fix = 0; fix < MAX_FIXES; fix++) {
    const found = findForbiddenTerms(letter, forbiddenTerms);
    if (found.length === 0) return letter;
    letter = await llm.writeLetter({
      ...base,
      previousLetter: letter,
      feedback: `Прибери з листа згадки: ${found.join(', ')}. Опиши цей досвід нейтрально, без назв компаній і без назви галузі. Решту листа залиш як є.`,
    });
  }

  const found = findForbiddenTerms(letter, forbiddenTerms);
  if (found.length) throw new ForbiddenTermsError(found);
  return letter;
}
