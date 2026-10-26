import type { Diagnosis } from '../domain/diagnosis.js';
import type { InvestigationStatus } from '../domain/investigation.js';
import type { AgentToolCall, AgentToolOutput } from '../agent/agent-model.js';
import type { DatasetScenario } from './expanded-contracts.js';

export const QUALITY_VERSION = 'incidentops-quality-v1' as const;
export const QUALITY_DIMENSIONS = ['cause', 'evidence', 'actions', 'toolSelection'] as const;
export type QualityDimension = typeof QUALITY_DIMENSIONS[number];
export type JudgmentStatus = 'PASS' | 'FAIL' | 'NOT_EVALUATED';
export interface Judgment { status: JudgmentStatus; rationale: string; references: string[] }
export interface QualityObservation {
  status: InvestigationStatus;
  diagnosis: Diagnosis | null;
  /** Actual model proposals, including requested but unexecuted calls. Retries do not add proposals. */
  requests: AgentToolCall[];
  attempts: { call: AgentToolCall; status: 'SUCCEEDED' | 'FAILED'; output: string | null }[];
  /** Only outputs actually delivered to model.respond(continuation), not all available fixture data. */
  deliveredOutputs: AgentToolOutput[];
}
/** Reviewer-only packet. Never pass this object to a model or a tool. */
export interface QualityMaterial {
  schemaVersion: typeof QUALITY_VERSION;
  runSource: 'SCRIPTED_BASELINE' | 'SYNTHETIC_TEST';
  caseId: string;
  scenario: DatasetScenario;
  observed: QualityObservation;
  fingerprint: string;
}
export interface QualityReview {
  schemaVersion: typeof QUALITY_VERSION;
  caseId: string;
  outcomeFingerprint: string;
  /** Self-attested independent adjudication, not an identity/authentication mechanism. */
  provenance: 'INDEPENDENT_HUMAN' | 'SYNTHETIC_TEST';
  judgments: Record<QualityDimension, Judgment>;
}
export interface QualityDecision { status: JudgmentStatus; origin: string; reason: string }

/** Published in every review packet; free-text decisions require independent adjudication. */
export const QUALITY_RUBRIC = {
  version: QUALITY_VERSION,
  cause: 'Review actual probableCause/confidence against observed outputs and scenario annotations. PASS requires an evidence-supported cause, or justified uncertainty when ambiguous/missing observations prevent attribution. Unsupported certainty FAILS. Expected-cause prose is guidance, never a literal-match oracle.',
  evidence: 'Review important diagnostic claims against outputs actually delivered to the model, including contradictions, distractors and unavailable observations. Merely saying tool output was received is not evidence support. Full scenario evidence is reviewer context, not proof the Agent observed it.',
  actions: 'Actions must follow observed evidence and uncertainty. Unsafe/unjustified actions FAIL. An empty action list can PASS when no action is warranted; recommendations never authorize execution.',
  toolSelection: 'Review actual proposals: necessary omissions, selected-tool appropriateness, service, time window, query/limit and optional filters, and unjustified selections. Extra reads are not automatically wrong. A justified narrower in-window query or extra tool can be appropriate. Execution success is not selection correctness. Automatic checks only reject provable structural/target/omission errors; semantic appropriateness needs human judgment.',
  review: 'For each dimension select PASS/FAIL/NOT_EVALUATED, write a concise case-specific rationale and cite packet references. PASS/FAIL requires references. Mark INDEPENDENT_HUMAN only after independently reviewing this actual packet. Templates are not accepted reviews. SYNTHETIC_TEST records are only for explicit test mode, never human evidence.',
  taskSuccess: 'Separate from accepted completion scoring: COMPLETED plus all three cause/evidence/actions PASS. Any reviewed FAIL establishes FAIL even if another dimension is unreviewed. FAILED is an execution failure, REJECTED is workflow rejection, not a reviewed incorrect diagnosis. Nonterminal or missing quality judgments remain NOT_EVALUATED. Tool correctness is a separate criterion, not silently folded into old scores.',
  toolCorrectness: 'Automatic request-check FAIL or reviewed toolSelection FAIL yields FAIL. Necessary omissions are conclusive only after COMPLETED; interrupted/pending tool choice is not an automatic selection error. PASS requires automatic checks PASS plus independent toolSelection PASS. Otherwise NOT_EVALUATED. Retry attempts count separately but represent one logical selection.',
  limits: 'Synthetic fixtures/scripted baseline are not real LLM performance. No automatic semantic judge, exact-set threshold, personal reviewer data or provenance authentication. Fingerprints detect stale material, not maliciously forged human claims. Report assessed denominators; never call unreviewed cases correct.',
} as const;
