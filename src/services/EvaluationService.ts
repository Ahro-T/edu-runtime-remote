import { randomUUID } from 'crypto';
import type { Logger } from 'pino';
import type { LearnerStateStore } from '../ports/LearnerStateStore.js';
import type { LearnerEventStore } from '../ports/LearnerEventStore.js';
import type { SubmissionStore } from '../ports/SubmissionStore.js';
import type { SubmissionEvaluation } from '../domain/learner/SubmissionEvaluation.js';
import { AppError } from '../domain/errors.js';
import { transitionNodeState } from '../domain/learner/state-machines.js';

export interface EvaluationServiceDeps {
  learnerStateStore: LearnerStateStore;
  learnerEventStore: LearnerEventStore;
  submissionStore: SubmissionStore;
  logger: Logger;
}

export class EvaluationService {
  private readonly store: LearnerStateStore;
  private readonly eventStore: LearnerEventStore;
  private readonly submissionStore: SubmissionStore;
  private readonly logger: Logger;

  constructor({ learnerStateStore, learnerEventStore, submissionStore, logger }: EvaluationServiceDeps) {
    this.store = learnerStateStore;
    this.eventStore = learnerEventStore;
    this.submissionStore = submissionStore;
    this.logger = logger.child({ service: 'EvaluationService' });
  }

  async recordEvaluation(
    submissionId: string,
    evaluation: Omit<SubmissionEvaluation, 'submissionId'>,
  ): Promise<SubmissionEvaluation> {
    const log = this.logger.child({ submissionId });

    const submission = await this.submissionStore.getSubmission(submissionId);
    if (!submission) throw new AppError('SESSION_NOT_FOUND', `Submission not found: ${submissionId}`);

    const full: SubmissionEvaluation = { submissionId, ...evaluation };
    const saved = await this.submissionStore.createEvaluation(full);

    // Transition NodeState based on result
    const existingState = await this.store.getNodeState(submission.learnerId, submission.nodeId);
    if (existingState) {
      const now = new Date();
      let nextStatus = existingState.status;
      let passedAt = existingState.passedAt;

      if (evaluation.result === 'pass') {
        nextStatus = transitionNodeState(existingState.status, 'pass');
        passedAt = now;
      } else if (evaluation.result === 'remediation') {
        nextStatus = transitionNodeState(existingState.status, 'fail_remediation');
      }
      // 'fail' stays in studying

      await this.store.upsertNodeState({
        ...existingState,
        status: nextStatus,
        lastScore: evaluation.score,
        lastSubmissionId: submissionId,
        passedAt,
        updatedAt: now,
      });
    }

    const eventType = evaluation.result === 'pass' ? 'submission_passed' :
                      evaluation.result === 'remediation' ? 'remediation_assigned' :
                      'submission_failed';

    await this.eventStore.appendEvent({
      id: randomUUID(),
      type: eventType,
      learnerId: submission.learnerId,
      sessionId: submission.sessionId,
      nodeId: submission.nodeId,
      timestamp: new Date(),
      payload: { submissionId, result: evaluation.result, score: evaluation.score },
    });

    log.info({ result: evaluation.result, score: evaluation.score }, 'Evaluation recorded');
    return saved;
  }
}
