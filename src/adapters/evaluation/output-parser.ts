export interface RawEvalResponse {
  result: 'pass' | 'fail' | 'remediation';
  score: number;
  rubricSlots: Record<string, { present: boolean; quality: string }>;
  feedback: string;
  missingPoints: string[];
  confidence: number; // TRANSIENT — stripped by guardrails, never persisted
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

const REQUIRED_FIELDS = ['result', 'score', 'rubricSlots', 'feedback', 'missingPoints', 'confidence'] as const;
const VALID_RESULTS = new Set(['pass', 'fail', 'remediation']);
const REQUIRED_SLOTS = ['definition', 'importance', 'relation', 'example', 'boundary'] as const;

export function parseEvalOutput(content: string): RawEvalResponse {
  // Strip markdown code fences if present
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ParseError(`Failed to parse JSON from LLM response: ${content.slice(0, 200)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ParseError('LLM response is not a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) {
      throw new ParseError(`Missing required field: ${field}`);
    }
  }

  if (!VALID_RESULTS.has(obj['result'] as string)) {
    throw new ParseError(`Invalid result value: ${String(obj['result'])}`);
  }

  if (typeof obj['score'] !== 'number' || obj['score'] < 0 || obj['score'] > 100) {
    throw new ParseError(`Invalid score: ${String(obj['score'])}`);
  }

  if (typeof obj['rubricSlots'] !== 'object' || obj['rubricSlots'] === null) {
    throw new ParseError('rubricSlots must be an object');
  }

  const rubricSlots = obj['rubricSlots'] as Record<string, unknown>;
  for (const slot of REQUIRED_SLOTS) {
    if (!(slot in rubricSlots)) {
      throw new ParseError(`Missing rubricSlot: ${slot}`);
    }
    const slotVal = rubricSlots[slot] as Record<string, unknown>;
    if (typeof slotVal['present'] !== 'boolean') {
      throw new ParseError(`rubricSlots.${slot}.present must be boolean`);
    }
    if (typeof slotVal['quality'] !== 'string') {
      throw new ParseError(`rubricSlots.${slot}.quality must be string`);
    }
  }

  if (typeof obj['feedback'] !== 'string') {
    throw new ParseError('feedback must be a string');
  }

  if (!Array.isArray(obj['missingPoints'])) {
    throw new ParseError('missingPoints must be an array');
  }

  if (typeof obj['confidence'] !== 'number' || obj['confidence'] < 0 || obj['confidence'] > 1) {
    throw new ParseError(`Invalid confidence: ${String(obj['confidence'])}`);
  }

  return {
    result: obj['result'] as 'pass' | 'fail' | 'remediation',
    score: obj['score'] as number,
    rubricSlots: obj['rubricSlots'] as Record<string, { present: boolean; quality: string }>,
    feedback: obj['feedback'] as string,
    missingPoints: (obj['missingPoints'] as unknown[]).map(String),
    confidence: obj['confidence'] as number,
  };
}
