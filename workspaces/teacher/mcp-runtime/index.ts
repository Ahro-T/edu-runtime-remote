import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = process.env.RUNTIME_API_URL || "http://localhost:3000";

async function callApi(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function ok(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const PILLARS = z.enum(["agents", "harnesses", "openclaw", "foundations"]);

const server = new McpServer({
  name: "edu-runtime",
  version: "0.1.0",
});

server.tool(
  "upsert_learner",
  "Register or find a learner by Discord user ID. Returns learnerId.",
  { discordUserId: z.string() },
  async ({ discordUserId }) => {
    try {
      return ok(await callApi("POST", "/api/learners/upsert", { discordUserId }));
    } catch (e) {
      return err(`upsert_learner failed: ${e}`);
    }
  },
);

server.tool(
  "start_session",
  "Start or resume a learning session for a pillar. Returns sessionId and current node.",
  {
    learnerId: z.string(),
    pillar: PILLARS,
    channelId: z.string().optional(),
  },
  async ({ learnerId, pillar, channelId }) => {
    try {
      return ok(await callApi("POST", "/api/sessions/start-or-resume", { learnerId, pillar, channelId }));
    } catch (e) {
      return err(`start_session failed: ${e}`);
    }
  },
);

server.tool(
  "get_current_node",
  "Get the learner's current knowledge node for a pillar. Returns node content and assessment template.",
  {
    learnerId: z.string(),
    pillar: PILLARS,
  },
  async ({ learnerId, pillar }) => {
    try {
      return ok(await callApi("GET", `/api/learners/${learnerId}/current-node?pillar=${pillar}`));
    } catch (e) {
      return err(`get_current_node failed: ${e}`);
    }
  },
);

server.tool(
  "record_submission",
  "Record a learner's free-text answer for evaluation. Returns submissionId.",
  {
    learnerId: z.string(),
    sessionId: z.string(),
    nodeId: z.string(),
    rawAnswer: z.string(),
  },
  async ({ learnerId, sessionId, nodeId, rawAnswer }) => {
    try {
      return ok(await callApi("POST", "/api/submissions", { learnerId, sessionId, nodeId, rawAnswer }));
    } catch (e) {
      return err(`record_submission failed: ${e}`);
    }
  },
);

server.tool(
  "record_evaluation",
  "Record a pre-computed evaluation result for a submission. The agent evaluates the answer and provides the result.",
  {
    submissionId: z.string(),
    result: z.enum(["pass", "fail", "remediation"]),
    score: z.number().min(0).max(100),
    rubricSlots: z.array(z.object({
      slot: z.string(),
      score: z.number(),
      feedback: z.string(),
    })).default([]),
    feedback: z.string(),
    missingPoints: z.array(z.string()).default([]),
    evaluatorModel: z.string().default("google/gemma-4-27b-it"),
  },
  async ({ submissionId, ...evalData }) => {
    try {
      return ok(await callApi("POST", `/api/submissions/${submissionId}/record-evaluation`, evalData));
    } catch (e) {
      return err(`record_evaluation failed: ${e}`);
    }
  },
);

server.tool(
  "advance_node",
  "Move the learner to the next node in the prerequisite graph after passing evaluation.",
  {
    learnerId: z.string(),
    pillar: PILLARS,
  },
  async ({ learnerId, pillar }) => {
    try {
      return ok(await callApi("POST", "/api/nodes/advance", { learnerId, pillar }));
    } catch (e) {
      return err(`advance_node failed: ${e}`);
    }
  },
);

server.tool(
  "schedule_review",
  "Schedule a spaced-repetition review for a passed node.",
  {
    learnerId: z.string(),
    nodeId: z.string(),
  },
  async ({ learnerId, nodeId }) => {
    try {
      return ok(await callApi("POST", "/api/reviews/schedule", { learnerId, nodeId }));
    } catch (e) {
      return err(`schedule_review failed: ${e}`);
    }
  },
);

server.tool(
  "get_dashboard",
  "Get full learner progress: current node, session state, pending reviews, pillar progress.",
  { learnerId: z.string() },
  async ({ learnerId }) => {
    try {
      return ok(await callApi("GET", `/api/learners/${learnerId}/dashboard`));
    } catch (e) {
      return err(`get_dashboard failed: ${e}`);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
