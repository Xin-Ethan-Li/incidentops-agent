import type { RunbookDocument } from '../domain/runbook.js';
import { runbooks } from '../fixtures/index.js';
import { ToolError } from './tool-error.js';

export interface SearchRunbookInput { query: string; limit?: number }

/** search_runbook: unique whitespace-separated terms, case-insensitive substring matching.
 * Per term: title=3, tags=2, content=1. Any term may match; ties use ascending ID.
 * Omitted limit returns all matches. Scores are internal, not diagnosis/confidence.
 */
export function searchRunbook(input: SearchRunbookInput): RunbookDocument[] {
  if (typeof input?.query !== 'string' || !input.query.trim()) {
    throw new ToolError('INVALID_INPUT', 'query must be a nonempty string');
  }
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit <= 0)) {
    throw new ToolError('INVALID_INPUT', 'limit must be a positive safe integer');
  }
  const terms = [...new Set(input.query.trim().toLowerCase().split(/\s+/))];
  return runbooks.map(runbook => ({ runbook, score: terms.reduce((score, term) => score
    + (runbook.title.toLowerCase().includes(term) ? 3 : 0)
    + (runbook.tags.some(tag => tag.toLowerCase().includes(term)) ? 2 : 0)
    + (runbook.content.toLowerCase().includes(term) ? 1 : 0), 0) }))
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score || (a.runbook.id < b.runbook.id ? -1 : a.runbook.id > b.runbook.id ? 1 : 0))
    .slice(0, input.limit)
    .map(({ runbook }) => ({ ...runbook, tags: [...runbook.tags] }));
}
