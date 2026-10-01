import { z } from 'zod';
import { CEFR_LEVELS } from './cefr.ts';

export const AssessmentSchema = z.object({
  score: z.int().min(0).max(100).describe('Наскільки вакансія підходить кандидату, 0-100'),
  verdict: z.enum(['apply', 'maybe', 'skip']),
  role: z.enum(['frontend', 'backend', 'fullstack', 'other']),
  aiFocus: z
    .enum(['none', 'some', 'core'])
    .describe('none — AI не згадується; some — AI-інструменти/фічі як плюс; core — LLM/агенти в основі продукту чи задач'),
  englishRequired: z.enum([...CEFR_LEVELS, 'unknown']),
  pros: z.array(z.string()).max(3).describe('Що збігається, коротко, російською'),
  cons: z.array(z.string()).max(3).describe('Що не збігається або насторожує, коротко, російською'),
  summary: z.string().describe('Одне речення російською: що за роль і чому такий бал'),
});
export type Assessment = z.infer<typeof AssessmentSchema>;

export const LetterSchema = z.object({
  letter: z.string().min(1).describe('Текст відгуку українською, без підпису-шаблону в квадратних дужках'),
});
export type Letter = z.infer<typeof LetterSchema>;

export const ChatReplySchema = z.object({
  reply: z.string().min(1).describe('Коротка відповідь кандидату російською: що змінено в листі або відповідь на питання'),
  letter: z.string().describe('Повний новий текст листа українською, або порожній рядок, якщо лист не змінюється'),
});
