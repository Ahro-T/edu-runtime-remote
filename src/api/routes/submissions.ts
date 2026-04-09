import type { FastifyInstance } from 'fastify';
import type { SubmissionService } from '../../services/SubmissionService.js';
import type { EvaluationService } from '../../services/EvaluationService.js';

interface RecordSubmissionBody {
  learnerId: string;
  sessionId: string;
  nodeId: string;
  rawAnswer: string;
}

interface RecordEvaluationBody {
  result: 'pass' | 'fail' | 'remediation';
  score: number;
  rubricSlots: Array<{ slot: string; score: number; feedback: string }>;
  feedback: string;
  missingPoints: string[];
  evaluatorModel: string;
}

export function submissionsRoutes(submissionService: SubmissionService, evaluationService: EvaluationService) {
  return async function (app: FastifyInstance): Promise<void> {
    app.post<{ Body: RecordSubmissionBody }>('/api/submissions', {
      schema: {
        body: {
          type: 'object',
          required: ['learnerId', 'sessionId', 'nodeId', 'rawAnswer'],
          properties: {
            learnerId: { type: 'string', minLength: 1 },
            sessionId: { type: 'string', minLength: 1 },
            nodeId: { type: 'string', minLength: 1 },
            rawAnswer: { type: 'string', minLength: 1 },
          },
        },
      },
    }, async (request, reply) => {
      const { learnerId, sessionId, nodeId, rawAnswer } = request.body;
      const submission = await submissionService.recordSubmission(learnerId, sessionId, nodeId, rawAnswer);
      reply.status(201).send({ submission });
    });

    app.post<{ Params: { submissionId: string }; Body: RecordEvaluationBody }>('/api/submissions/:submissionId/record-evaluation', {
      schema: {
        params: {
          type: 'object',
          required: ['submissionId'],
          properties: { submissionId: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['result', 'score', 'feedback', 'evaluatorModel'],
          properties: {
            result: { type: 'string', enum: ['pass', 'fail', 'remediation'] },
            score: { type: 'number', minimum: 0, maximum: 100 },
            rubricSlots: {
              type: 'array',
              items: {
                type: 'object',
                required: ['slot', 'score', 'feedback'],
                properties: {
                  slot: { type: 'string' },
                  score: { type: 'number' },
                  feedback: { type: 'string' },
                },
              },
            },
            feedback: { type: 'string' },
            missingPoints: { type: 'array', items: { type: 'string' } },
            evaluatorModel: { type: 'string' },
          },
        },
      },
    }, async (request, reply) => {
      const { result, score, rubricSlots } = request.body;

      // Score-result consistency validation
      if (result === 'pass' && score < 60) {
        return reply.status(400).send({ error: 'Score must be >= 60 for pass result' });
      }
      if (result === 'fail' && score > 80) {
        return reply.status(400).send({ error: 'Score must be <= 80 for fail result' });
      }
      // Slot-presence guardrail: no pass with any slot scoring 0
      if (result === 'pass' && rubricSlots?.some((s) => s.score === 0)) {
        return reply.status(400).send({ error: 'Cannot pass with any slot scoring 0' });
      }

      const evaluation = await evaluationService.recordEvaluation(
        request.params.submissionId,
        request.body,
      );
      reply.send({ evaluation });
    });
  };
}
