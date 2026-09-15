/** Valid structure does not establish cause correctness or calibrated confidence. */
export interface Diagnosis {
  summary: string;
  probableCause: string;
  confidence: 'low' | 'medium' | 'high';
  evidence: string[];
  /** Recommendations are data only, never execution authorization. */
  recommendedActions: string[];
}

const fields = ['summary', 'probableCause', 'confidence', 'evidence', 'recommendedActions'];
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function assertDiagnosis(value: unknown): asserts value is Diagnosis {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !fields.includes(key))
    || fields.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError('Malformed diagnosis: exactly the five required fields must be present');
  }
  const diagnosis = value as Record<string, unknown>;
  if (!nonempty(diagnosis.summary) || !nonempty(diagnosis.probableCause)) {
    throw new TypeError('Malformed diagnosis: summary and probableCause must be nonempty strings');
  }
  if (diagnosis.confidence !== 'low' && diagnosis.confidence !== 'medium' && diagnosis.confidence !== 'high') {
    throw new TypeError('Malformed diagnosis: confidence must be low, medium or high');
  }
  for (const field of ['evidence', 'recommendedActions']) {
    const items = diagnosis[field];
    if (!Array.isArray(items) || !Array.from(items).every(nonempty)) {
      throw new TypeError('Malformed diagnosis: ' + field + ' must be an array of nonempty strings');
    }
  }
}

/** Provider schema supplements, but never replaces, application runtime validation. */
export const DIAGNOSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: fields,
  properties: {
    summary: { type: 'string', pattern: '\\S' },
    probableCause: { type: 'string', pattern: '\\S' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    evidence: { type: 'array', items: { type: 'string', pattern: '\\S' } },
    recommendedActions: { type: 'array', items: { type: 'string', pattern: '\\S' } },
  },
};
