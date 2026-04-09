import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EvaluationService } from '../EvaluationService.js';
import type { LearnerStateStore } from '../../ports/LearnerStateStore.js';
import type { LearnerEventStore } from '../../ports/LearnerEventStore.js';
import type { SubmissionStore } from '../../ports/SubmissionStore.js';
import type { Submission } from '../../domain/learner/Submission.js';
import type { NodeState } from '../../domain/learner/NodeState.js';
import type { SubmissionEvaluation } from '../../domain/learner/SubmissionEvaluation.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

const mockSubmission: Submission = {
  id: 'sub-1',
  learnerId: 'learner-1',
  sessionId: 'session-1',
  nodeId: 'node-1',
  templateId: 'tpl-1',
  rawAnswer: 'Answer',
  submittedAt: new Date(),
};

const mockNodeState: NodeState = {
  id: 'ns-1',
  learnerId: 'learner-1',
  nodeId: 'node-1',
  status: 'studying',
  masteryLevel: 'descriptive',
  attemptCount: 1,
  lastScore: null,
  lastSubmissionId: 'sub-1',
  nextReviewAt: null,
  passedAt: null,
  updatedAt: new Date(),
};

const mockEvalPayload: Omit<SubmissionEvaluation, 'submissionId'> = {
  evaluatorModel: 'test-model',
  result: 'pass',
  score: 90,
  rubricSlots: [{ slot: 'definition', score: 100, feedback: 'Good' }],
  feedback: 'Good',
  missingPoints: [],
};

function makeStores() {
  const stateStore: LearnerStateStore = {
    upsertLearner: vi.fn(async (l) => l),
    getLearnerById: vi.fn(async () => null),
    getLearnerByDiscordId: vi.fn(async () => null),
    createSession: vi.fn(async (s) => ({ ...s, status: 'active', metadata: {}, startedAt: new Date(), updatedAt: new Date() })),
    getSession: vi.fn(async () => null),
    getActiveSession: vi.fn(async () => null),
    updateSessionStatus: vi.fn(async (id, status) => ({ id, learnerId: '', pillar: 'agents', currentNodeId: null, channelId: '', status, metadata: {}, startedAt: new Date(), updatedAt: new Date() })),
    getNodeState: vi.fn(async () => mockNodeState),
    upsertNodeState: vi.fn(async (ns) => ns),
    getNodeStatesForLearner: vi.fn(async () => []),
    getNodeStatesForSession: vi.fn(async () => []),
  };

  const eventStore: LearnerEventStore = {
    appendEvent: vi.fn(async (e) => e),
    getEventsForLearner: vi.fn(async () => []),
    getEventsForSession: vi.fn(async () => []),
    createReviewJob: vi.fn(async (j) => j),
    getPendingJobs: vi.fn(async () => []),
    updateJobStatus: vi.fn(async (id, status) => ({ id, learnerId: '', nodeId: '', jobType: 'review' as const, status, scheduledFor: new Date(), payload: {} })),
  };

  const submissionStore: SubmissionStore = {
    createSubmission: vi.fn(async (s) => s),
    getSubmission: vi.fn(async () => mockSubmission),
    getSubmissionsForNode: vi.fn(async () => []),
    createEvaluation: vi.fn(async (e) => e),
    getEvaluationForSubmission: vi.fn(async () => null),
  };

  return { stateStore, eventStore, submissionStore };
}

describe('EvaluationService', () => {
  let service: EvaluationService;
  let stores: ReturnType<typeof makeStores>;

  beforeEach(() => {
    stores = makeStores();
    service = new EvaluationService({
      learnerStateStore: stores.stateStore,
      learnerEventStore: stores.eventStore,
      submissionStore: stores.submissionStore,
      logger,
    });
  });

  it('records a pre-computed evaluation and returns result', async () => {
    const result = await service.recordEvaluation('sub-1', mockEvalPayload);
    expect(result.result).toBe('pass');
    expect(result.score).toBe(90);
    expect(result.submissionId).toBe('sub-1');
  });

  it('transitions node state to passed on pass result', async () => {
    await service.recordEvaluation('sub-1', mockEvalPayload);
    const upsert = vi.mocked(stores.stateStore.upsertNodeState).mock.calls[0][0];
    expect(upsert.status).toBe('passed');
    expect(upsert.passedAt).toBeInstanceOf(Date);
  });

  it('transitions node state to remediation on remediation result', async () => {
    await service.recordEvaluation('sub-1', { ...mockEvalPayload, result: 'remediation', score: 30 });
    const upsert = vi.mocked(stores.stateStore.upsertNodeState).mock.calls[0][0];
    expect(upsert.status).toBe('remediation');
  });

  it('throws when submission not found', async () => {
    vi.mocked(stores.submissionStore.getSubmission).mockResolvedValue(null);
    await expect(service.recordEvaluation('no-such', mockEvalPayload)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('emits submission_passed event on pass', async () => {
    await service.recordEvaluation('sub-1', mockEvalPayload);
    const event = vi.mocked(stores.eventStore.appendEvent).mock.calls[0][0];
    expect(event.type).toBe('submission_passed');
  });

  it('emits remediation_assigned event on remediation', async () => {
    await service.recordEvaluation('sub-1', { ...mockEvalPayload, result: 'remediation', score: 30 });
    const event = vi.mocked(stores.eventStore.appendEvent).mock.calls[0][0];
    expect(event.type).toBe('remediation_assigned');
  });
});
