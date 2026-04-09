/**
 * Smoke test 2: pass node -> advance -> schedule review -> verify
 *
 * Uses real Postgres (Testcontainers) + real ObsidianContentRepository + mocked vLLM engine.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import * as schema from '../adapters/db/schema.js';
import { DrizzleLearnerStateStore } from '../adapters/db/DrizzleLearnerStateStore.js';
import { DrizzleSubmissionStore } from '../adapters/db/DrizzleSubmissionStore.js';
import { DrizzleLearnerEventStore } from '../adapters/db/DrizzleLearnerEventStore.js';
import { ObsidianContentRepository } from '../adapters/content/obsidian/ObsidianContentRepository.js';
import { LearnerService } from '../services/LearnerService.js';
import { SessionService } from '../services/SessionService.js';
import { SubmissionService } from '../services/SubmissionService.js';
import { EvaluationService } from '../services/EvaluationService.js';
import { AdvancementService } from '../services/AdvancementService.js';
import { ReviewService } from '../services/ReviewService.js';
import { createLogger } from '../logger.js';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_PATH = path.resolve(__dirname, '../../wiki-vault');

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const logger = createLogger('smoke-test-2');

async function createSchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS learners (
      id TEXT PRIMARY KEY,
      discord_user_id TEXT NOT NULL UNIQUE,
      current_pillar TEXT,
      current_session_id TEXT
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS learner_sessions (
      id TEXT PRIMARY KEY,
      learner_id TEXT NOT NULL REFERENCES learners(id),
      status TEXT NOT NULL,
      pillar TEXT NOT NULL,
      current_node_id TEXT,
      channel_id TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS node_states (
      id TEXT PRIMARY KEY,
      learner_id TEXT NOT NULL REFERENCES learners(id),
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      mastery_level TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_score REAL,
      last_submission_id TEXT,
      next_review_at TIMESTAMPTZ,
      passed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (learner_id, node_id)
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      learner_id TEXT NOT NULL REFERENCES learners(id),
      session_id TEXT NOT NULL REFERENCES learner_sessions(id),
      node_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      raw_answer TEXT NOT NULL,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS submission_evaluations (
      submission_id TEXT PRIMARY KEY REFERENCES submissions(id),
      evaluator_model TEXT NOT NULL,
      result TEXT NOT NULL,
      score REAL NOT NULL,
      rubric_slots JSONB NOT NULL DEFAULT '[]',
      feedback TEXT NOT NULL,
      missing_points JSONB NOT NULL DEFAULT '[]'
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS review_jobs (
      id TEXT PRIMARY KEY,
      learner_id TEXT NOT NULL REFERENCES learners(id),
      node_id TEXT NOT NULL,
      job_type TEXT NOT NULL CHECK (job_type IN ('review', 'retry', 'reminder')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
      scheduled_for TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS learning_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      learner_id TEXT NOT NULL REFERENCES learners(id),
      session_id TEXT NOT NULL,
      node_id TEXT,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload JSONB NOT NULL DEFAULT '{}'
    )
  `);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });
  await createSchema();
}, 90000);

afterAll(async () => {
  await pool.end();
  await container.stop();
}, 30000);

describe('Smoke: pass node -> advance -> schedule review', () => {
  it('advances to next node after passing current, and schedules review', async () => {
    // --- Wire up stores ---
    const stateStore = new DrizzleLearnerStateStore(db as any, logger);
    const submissionStore = new DrizzleSubmissionStore(db as any, logger);
    const eventStore = new DrizzleLearnerEventStore(db as any, logger);
    const contentRepo = new ObsidianContentRepository(VAULT_PATH, logger);

    // --- Wire services ---
    const learnerService = new LearnerService({ learnerStateStore: stateStore, learnerEventStore: eventStore, logger });
    const sessionService = new SessionService({ learnerStateStore: stateStore, learnerEventStore: eventStore, contentRepository: contentRepo, logger });
    const submissionService = new SubmissionService({ learnerStateStore: stateStore, learnerEventStore: eventStore, submissionStore, contentRepository: contentRepo, logger });
    const evaluationService = new EvaluationService({ learnerStateStore: stateStore, learnerEventStore: eventStore, submissionStore, logger });
    const advancementService = new AdvancementService({ learnerStateStore: stateStore, learnerEventStore: eventStore, contentRepository: contentRepo, logger });
    const reviewService = new ReviewService({ learnerStateStore: stateStore, learnerEventStore: eventStore, logger });

    // 1. Create learner and session
    const learner = await learnerService.upsertLearner('discord-smoke-2');
    const session = await sessionService.startOrResume(learner.id, 'agents', 'channel-smoke-2');
    const firstNodeId = session.currentNodeId!;
    expect(firstNodeId).toBeTruthy();

    // 2. Submit and pass the first node
    const submission = await submissionService.recordSubmission(
      learner.id, session.id, firstNodeId,
      'The core loop drives agent behavior through perceive-think-act iterations.',
    );
    await evaluationService.recordEvaluation(submission.id, { evaluatorModel: 'mock-model', result: 'pass', score: 85, rubricSlots: [{ slot: 'definition', score: 100, feedback: 'Good' }], feedback: 'Well done', missingPoints: [] });

    // Verify first node is now passed
    const firstNodeState = await stateStore.getNodeState(learner.id, firstNodeId);
    expect(firstNodeState!.status).toBe('passed');

    // 3. Attempt to advance
    const result = await advancementService.advanceNode(learner.id, 'agents');
    // Either advances to next node or completes pillar (only 1 node may have no prereqs pointing to it)
    expect(result.advanced || result.pillarCompleted).toBe(true);

    if (result.advanced) {
      expect(result.nextNode).not.toBeNull();
      const updatedSession = await stateStore.getActiveSession(learner.id, 'agents');
      expect(updatedSession!.currentNodeId).toBe(result.nextNode!.id);
    }

    // 4. Schedule a review for the passed node
    const scheduledFor = new Date(Date.now() + 72 * 60 * 60 * 1000); // 3 days
    const reviewJob = await reviewService.scheduleReview(learner.id, firstNodeId, { scheduledFor, jobType: 'review' });
    expect(reviewJob.id).toBeTruthy();
    expect(reviewJob.status).toBe('pending');
    expect(reviewJob.nodeId).toBe(firstNodeId);

    // 5. Verify pending jobs contain our review
    const pendingJobs = await eventStore.getPendingJobs(learner.id);
    const our = pendingJobs.find((j) => j.id === reviewJob.id);
    expect(our).toBeDefined();
    expect(our!.jobType).toBe('review');

    // 6. Verify NodeState.nextReviewAt was set
    const firstNodeStateAfterReview = await stateStore.getNodeState(learner.id, firstNodeId);
    expect(firstNodeStateAfterReview!.nextReviewAt).toBeInstanceOf(Date);
  }, 90000);
});
