/**
 * OpenClaw API contract tests — verify that all 8 Runtime API endpoints return
 * the response shapes that the Teacher Agent's call-runtime-api skill expects.
 * These are contract tests against the real API (with real Postgres via Testcontainers).
 * They do NOT require OpenClaw Gateway to be running.
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
import { AdvancementService } from '../services/AdvancementService.js';
import { ReviewService } from '../services/ReviewService.js';
import { DashboardService } from '../services/DashboardService.js';
import { learnersRoutes } from '../api/routes/learners.js';
import { sessionsRoutes } from '../api/routes/sessions.js';
import { nodesRoutes } from '../api/routes/nodes.js';
import { submissionsRoutes } from '../api/routes/submissions.js';
import { reviewsRoutes } from '../api/routes/reviews.js';
import { dashboardRoutes } from '../api/routes/dashboard.js';
import { createServer } from '../api/server.js';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';
import type { FastifyInstance } from 'fastify';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_PATH = path.resolve(__dirname, '../../wiki-vault');

const logger = pino({ level: 'silent' });

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: FastifyInstance;

let learnerId: string;
let sessionId: string;
let nodeId: string;
let submissionId: string;

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

  const stateStore = new DrizzleLearnerStateStore(db as any, logger);
  const submissionStore = new DrizzleSubmissionStore(db as any, logger);
  const eventStore = new DrizzleLearnerEventStore(db as any, logger);
  const contentRepo = new ObsidianContentRepository(VAULT_PATH, logger);
  const learnerService = new LearnerService({ learnerStateStore: stateStore, learnerEventStore: eventStore, logger });
  const sessionService = new SessionService({ learnerStateStore: stateStore, learnerEventStore: eventStore, contentRepository: contentRepo, logger });
  const contentService = new ContentService({ learnerStateStore: stateStore, contentRepository: contentRepo, logger });
  const submissionService = new SubmissionService({ learnerStateStore: stateStore, learnerEventStore: eventStore, submissionStore, contentRepository: contentRepo, logger });
  const evaluationService = new EvaluationService({ learnerStateStore: stateStore, learnerEventStore: eventStore, submissionStore, logger });
  const advancementService = new AdvancementService({ learnerStateStore: stateStore, learnerEventStore: eventStore, contentRepository: contentRepo, logger });
  const reviewService = new ReviewService({ learnerStateStore: stateStore, learnerEventStore: eventStore, logger });
  const dashboardService = new DashboardService({ learnerStateStore: stateStore, learnerEventStore: eventStore, submissionStore, contentRepository: contentRepo, logger });

  app = createServer({
    learners: learnersRoutes(learnerService),
    sessions: sessionsRoutes(sessionService),
    nodes: nodesRoutes(contentService, advancementService),
    submissions: submissionsRoutes(submissionService, evaluationService),
    reviews: reviewsRoutes(reviewService),
    dashboard: dashboardRoutes(dashboardService),
  }, logger);

  await app.ready();
}, 90000);

afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
}, 30000);

/**
 * Contract: POST /api/learners/upsert
 * Expected by skill: { learner: { id, discordUserId } }
 */
describe('Contract: POST /api/learners/upsert', () => {
  it('returns { learner: { id, discordUserId } } shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/learners/upsert',
      payload: { discordUserId: 'discord-contract-test-1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('learner');
    expect(typeof body.learner.id).toBe('string');
    expect(body.learner.discordUserId).toBe('discord-contract-test-1');
    learnerId = body.learner.id;
  });
});

/**
 * Contract: POST /api/sessions/start-or-resume
 * Expected by skill: { session: { id, learnerId, pillar, status, currentNodeId, channelId } }
 */
describe('Contract: POST /api/sessions/start-or-resume', () => {
  it('returns { session: { id, learnerId, pillar, status, currentNodeId, channelId } } shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/start-or-resume',
      payload: { learnerId, pillar: 'agents', channelId: 'ch-contract-test' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('session');
    expect(typeof body.session.id).toBe('string');
    expect(body.session.learnerId).toBe(learnerId);
    expect(body.session.pillar).toBe('agents');
    expect(body.session.status).toBe('active');
    expect(typeof body.session.currentNodeId).toBe('string');
    expect(body.session.channelId).toBe('ch-contract-test');
    sessionId = body.session.id;
    nodeId = body.session.currentNodeId;
  });
});

/**
 * Contract: GET /api/learners/:learnerId/current-node?pillar=agents
 * Expected by skill: { node: { id, pillar, title, prerequisites, ... } }
 */
describe('Contract: GET /api/learners/:learnerId/current-node', () => {
  it('returns { node: { id, pillar } } shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/learners/${learnerId}/current-node?pillar=agents`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('node');
    expect(typeof body.node.id).toBe('string');
    expect(body.node.pillar).toBe('agents');
  });
});

/**
 * Contract: POST /api/submissions
 * Expected by skill: { submission: { id, learnerId, sessionId, nodeId, rawAnswer } }
 */
describe('Contract: POST /api/submissions', () => {
  it('returns { submission: { id, learnerId, sessionId, nodeId } } shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/submissions',
      payload: {
        learnerId,
        sessionId,
        nodeId,
        rawAnswer: 'The agent core loop is perceive-think-act repeated until goal is met.',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toHaveProperty('submission');
    expect(typeof body.submission.id).toBe('string');
    expect(body.submission.learnerId).toBe(learnerId);
    expect(body.submission.sessionId).toBe(sessionId);
    expect(body.submission.nodeId).toBe(nodeId);
    submissionId = body.submission.id;
  });
});

/**
 * Contract: POST /api/submissions/:submissionId/record-evaluation
 * Expected by skill: { evaluation: { result, score, feedback, rubricSlots, missingPoints } }
 */
describe('Contract: POST /api/submissions/:submissionId/record-evaluation', () => {
  it('returns { evaluation: { result, score, feedback } } shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/submissions/${submissionId}/record-evaluation`,
      payload: { result: 'pass', score: 90, rubricSlots: [{ slot: 'definition', score: 100, feedback: 'Good' }], feedback: 'Contract test pass', missingPoints: [], evaluatorModel: 'mock-model' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('evaluation');
    expect(['pass', 'fail', 'remediation']).toContain(body.evaluation.result);
    expect(typeof body.evaluation.score).toBe('number');
    expect(typeof body.evaluation.feedback).toBe('string');
    expect(Array.isArray(body.evaluation.rubricSlots)).toBe(true);
    expect(Array.isArray(body.evaluation.missingPoints)).toBe(true);
  });
});

/**
 * Contract: POST /api/nodes/advance
 * Expected by skill: { advanced: true, nextNodeId } | { pillarCompleted: true }
 */
describe('Contract: POST /api/nodes/advance', () => {
  it('returns advance result with advanced or pillarCompleted field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/nodes/advance',
      payload: { learnerId, pillar: 'agents' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const hasAdvanced = 'advanced' in body || 'nextNodeId' in body;
    const hasPillarCompleted = 'pillarCompleted' in body;
    expect(hasAdvanced || hasPillarCompleted).toBe(true);
  });
});

/**
 * Contract: POST /api/reviews/schedule
 * Expected by skill: { job: { id, learnerId, nodeId, status, scheduledFor, jobType } }
 */
describe('Contract: POST /api/reviews/schedule', () => {
  it('returns { job: { id, learnerId, nodeId, status, jobType } } shape', async () => {
    const scheduledFor = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const res = await app.inject({
      method: 'POST',
      url: '/api/reviews/schedule',
      payload: { learnerId, nodeId, scheduledFor, jobType: 'review' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toHaveProperty('job');
    expect(typeof body.job.id).toBe('string');
    expect(body.job.learnerId).toBe(learnerId);
    expect(body.job.nodeId).toBe(nodeId);
    expect(body.job.status).toBe('pending');
    expect(body.job.jobType).toBe('review');
  });
});

/**
 * Contract: GET /api/learners/:learnerId/dashboard
 * Expected by skill: { dashboard: { learner, nodeStates, passedNodes, pendingReviews } }
 */
describe('Contract: GET /api/learners/:learnerId/dashboard', () => {
  it('returns { dashboard: { learner, nodeStates, passedNodes } } shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/learners/${learnerId}/dashboard`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('dashboard');
    expect(body.dashboard.learner.id).toBe(learnerId);
    expect(Array.isArray(body.dashboard.nodeStates)).toBe(true);
    expect(typeof body.dashboard.passedNodes).toBe('number');
  });
});
