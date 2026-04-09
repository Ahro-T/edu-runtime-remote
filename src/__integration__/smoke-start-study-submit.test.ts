/**
 * Smoke test 1: upsert learner -> start session -> get node -> submit -> evaluate -> verify NodeState
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
import { ContentService } from '../services/ContentService.js';
import { SubmissionService } from '../services/SubmissionService.js';
import { EvaluationService } from '../services/EvaluationService.js';
import { createLogger } from '../logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_PATH = path.resolve(__dirname, '../../wiki-vault');

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const logger = createLogger('smoke-test-1');

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

describe('Smoke: start -> study -> submit -> evaluate', () => {
  it('completes the full learning loop and transitions NodeState to passed', async () => {
    // --- Wire up stores ---
    const stateStore = new DrizzleLearnerStateStore(db as any, logger);
    const submissionStore = new DrizzleSubmissionStore(db as any, logger);
    const eventStore = new DrizzleLearnerEventStore(db as any, logger);
    const contentRepo = new ObsidianContentRepository(VAULT_PATH, logger);

    // --- Wire services ---
    const learnerService = new LearnerService({ learnerStateStore: stateStore, learnerEventStore: eventStore, logger });
    const sessionService = new SessionService({ learnerStateStore: stateStore, learnerEventStore: eventStore, contentRepository: contentRepo, logger });
    const contentService = new ContentService({ learnerStateStore: stateStore, contentRepository: contentRepo, logger });
    const submissionService = new SubmissionService({ learnerStateStore: stateStore, learnerEventStore: eventStore, submissionStore, contentRepository: contentRepo, logger });
    const evaluationService = new EvaluationService({ learnerStateStore: stateStore, learnerEventStore: eventStore, submissionStore, logger });

    // 1. Upsert learner
    const learner = await learnerService.upsertLearner('discord-smoke-1');
    expect(learner.id).toBeTruthy();
    expect(learner.discordUserId).toBe('discord-smoke-1');

    // 2. Start session
    const session = await sessionService.startOrResume(learner.id, 'agents', 'channel-smoke-1');
    expect(session.status).toBe('active');
    expect(session.pillar).toBe('agents');
    expect(session.currentNodeId).toBeTruthy();

    // 3. Get current node
    const node = await contentService.getCurrentNode(learner.id, 'agents');
    expect(node.id).toBeTruthy();
    expect(node.pillar).toBe('agents');

    // 4. Record submission
    const submission = await submissionService.recordSubmission(
      learner.id,
      session.id,
      node.id,
      'The agent core loop is a perceive-think-act cycle that drives autonomous agent behavior.',
    );
    expect(submission.id).toBeTruthy();
    expect(submission.nodeId).toBe(node.id);

    // 5. Verify NodeState has incremented attemptCount
    const nodeStateAfterSubmit = await stateStore.getNodeState(learner.id, node.id);
    expect(nodeStateAfterSubmit).not.toBeNull();
    expect(nodeStateAfterSubmit!.attemptCount).toBe(1);

    // 6. Evaluate submission
    const evaluation = await evaluationService.recordEvaluation(submission.id, { evaluatorModel: 'mock-model', result: 'pass', score: 90, rubricSlots: [{ slot: 'definition', score: 100, feedback: 'Good' }], feedback: 'Well done', missingPoints: [] });
    expect(evaluation.result).toBe('pass');
    expect(evaluation.score).toBe(90);

    // 7. Verify NodeState transitioned to passed
    const nodeStateAfterEval = await stateStore.getNodeState(learner.id, node.id);
    expect(nodeStateAfterEval).not.toBeNull();
    expect(nodeStateAfterEval!.status).toBe('passed');
    expect(nodeStateAfterEval!.passedAt).toBeInstanceOf(Date);
    expect(nodeStateAfterEval!.lastScore).toBe(90);
  }, 90000);
});
