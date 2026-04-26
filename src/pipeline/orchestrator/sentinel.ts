/**
 * Open-questions sentinel — drafting subagents emit a structured fence in
 * streamed assistant text when they need human input. The orchestrator
 * content-matches this fence to interrupt and post `block:human`.
 */
export const OPEN_QUESTIONS_OPEN = "=== OPEN QUESTIONS (BLOCK:HUMAN) ===";
export const OPEN_QUESTIONS_CLOSE = "=== END OPEN QUESTIONS ===";

export interface OpenQuestionsMatch {
  /** True if both fences were found in `text`. */
  complete: boolean;
  /** True if just the opening fence was found (subsequent partial-message text expected). */
  openOnly: boolean;
  /** The questions block (between fences). Only populated when complete=true. */
  block?: string;
  /** Parsed numbered-list items. Only populated when complete=true. */
  questions?: string[];
}

/**
 * Match the sentinel fences in `text`. `text` may be:
 *  - A single full assistant message (one shot)
 *  - The accumulated buffer across stream-event deltas (called repeatedly as
 *    new deltas arrive, with the SAME accumulated buffer each time)
 *
 * Returns `complete: true` only when both fences are present. The orchestrator
 * uses `openOnly` to start buffering subsequent deltas; `complete` to fire the
 * cancel + Linear comment.
 */
export function detectOpenQuestions(text: string): OpenQuestionsMatch {
  const openIdx = text.indexOf(OPEN_QUESTIONS_OPEN);
  if (openIdx === -1) return { complete: false, openOnly: false };
  const afterOpen = openIdx + OPEN_QUESTIONS_OPEN.length;
  const closeIdx = text.indexOf(OPEN_QUESTIONS_CLOSE, afterOpen);
  if (closeIdx === -1) return { complete: false, openOnly: true };
  const block = text.slice(afterOpen, closeIdx).trim();
  const questions = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^\d+\.\s+/, ""));
  return { complete: true, openOnly: false, block, questions };
}
