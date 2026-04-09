import type { EvaluationEngine } from '../../ports/EvaluationEngine.js';
import type { Submission } from '../../domain/learner/Submission.js';
import type { SubmissionEvaluation } from '../../domain/learner/SubmissionEvaluation.js';
import type { KnowledgeNode } from '../../domain/content/KnowledgeNode.js';
import type { AssessmentTemplate } from '../../domain/content/AssessmentTemplate.js';
import { buildEvaluationPrompt } from './prompt-builder.js';
import { parseEvalOutput, ParseError } from './output-parser.js';
import { applyGuardrails } from './guardrails.js';
import { buildDegradedResult } from './degraded-mode.js';

interface VllmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface VllmChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

export class VllmEvaluationEngine implements EvaluationEngine {
  private readonly vllmUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly cfClientId?: string | undefined;
  private readonly cfClientSecret?: string | undefined;

  constructor(options: {
    vllmUrl: string;
    model?: string | undefined;
    timeoutMs?: number | undefined;
    cfClientId?: string | undefined;
    cfClientSecret?: string | undefined;
  }) {
    this.vllmUrl = options.vllmUrl.replace(/\/$/, '');
    this.model = options.model ?? 'default';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.cfClientId = options.cfClientId;
    this.cfClientSecret = options.cfClientSecret;
  }

  async evaluate(
    submission: Submission,
    node: KnowledgeNode,
    template: AssessmentTemplate,
  ): Promise<SubmissionEvaluation> {
    const prompt = buildEvaluationPrompt(submission, node, template);

    const messages: VllmChatMessage[] = [
      {
        role: 'system',
        content:
          'You are an educational evaluator. Return only valid JSON matching the requested schema. No markdown, no explanation.',
      },
      { role: 'user', content: prompt },
    ];

    let responseJson: VllmChatCompletionResponse;
    try {
      responseJson = await this.callVllm(messages);
    } catch (err) {
      // vLLM unreachable — return degraded sentinel
      // Caller is responsible for preserving the submission
      const degraded = buildDegradedResult();
      throw Object.assign(
        new Error(`Evaluation unavailable: ${degraded.error}`),
        { code: degraded.error, available: degraded.available },
      );
    }

    const content = responseJson.choices[0]?.message.content ?? '';
    const evaluatorModel = responseJson.model;

    const raw = parseEvalOutput(content);
    return applyGuardrails(raw, submission.id, evaluatorModel);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const headers: Record<string, string> = {};
        if (this.cfClientId) headers['CF-Access-Client-Id'] = this.cfClientId;
        if (this.cfClientSecret) headers['CF-Access-Client-Secret'] = this.cfClientSecret;
        const response = await fetch(`${this.vllmUrl}/health`, {
          signal: controller.signal,
          headers,
        });
        return response.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  private async callVllm(
    messages: VllmChatMessage[],
  ): Promise<VllmChatCompletionResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.cfClientId) headers['CF-Access-Client-Id'] = this.cfClientId;
      if (this.cfClientSecret) headers['CF-Access-Client-Secret'] = this.cfClientSecret;

      const response = await fetch(`${this.vllmUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.1,
          max_tokens: 1024,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`vLLM responded with status ${response.status}`);
      }

      return (await response.json()) as VllmChatCompletionResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}
