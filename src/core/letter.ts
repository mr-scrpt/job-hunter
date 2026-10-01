import type { ChatInput, ChatReply, Llm, LetterInput } from './ports.ts';

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

/** Sends a leaking letter back for targeted fixes; throws rather than return one that still leaks. */
async function cleanLetter(llm: Llm, base: LetterInput, letter: string, terms: readonly string[]): Promise<string> {
  let current = letter;
  for (let fix = 0; fix < MAX_FIXES; fix++) {
    const found = findForbiddenTerms(current, terms);
    if (found.length === 0) return current;
    current = await llm.writeLetter({
      ...base,
      previousLetter: current,
      feedback: `Прибери з листа згадки: ${found.join(', ')}. Опиши цей досвід нейтрально, без назв компаній і без назви галузі. Решту листа залиш як є.`,
    });
  }
  const found = findForbiddenTerms(current, terms);
  if (found.length) throw new ForbiddenTermsError(found);
  return current;
}

/**
 * Writes a letter and guarantees none of `forbiddenTerms` leaks into it: the model gets the list up front,
 * and any slip is sent back for a targeted fix.
 */
export async function writeCheckedLetter(llm: Llm, input: LetterInput, forbiddenTerms: readonly string[]): Promise<string> {
  const base: LetterInput = { ...input, forbiddenTerms: [...forbiddenTerms] };
  return cleanLetter(llm, base, await llm.writeLetter(base), forbiddenTerms);
}

/** One chat turn about a vacancy; a letter it produces goes through the same forbidden-terms guard. */
export async function checkedChat(llm: Llm, input: ChatInput, forbiddenTerms: readonly string[]): Promise<ChatReply> {
  const result = await llm.chat({ ...input, forbiddenTerms: [...forbiddenTerms] });
  if (!result.letter) return result;
  const base: LetterInput = {
    vacancy: input.vacancy,
    resume: input.resume,
    candidateName: input.candidateName,
    assessment: input.assessment,
    forbiddenTerms: [...forbiddenTerms],
  };
  return { ...result, letter: await cleanLetter(llm, base, result.letter, forbiddenTerms) };
}
