import type { Response } from 'express';
import { runWorkerTextStream } from '../ollama.js';
import { nowSeconds, openAICompletionId } from './responseBuilders.js';
import { getPolicyFallbackModel } from '../ai/modelPolicy.js';
import { log } from '../log.js';

type StreamDeltaEvent = {
  type: 'text-delta';
  textDelta: string;
};

function sendSSEChunk(res: Response, chunk: unknown): void {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function isTextDeltaEvent(part: unknown): part is StreamDeltaEvent {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'text-delta' &&
    typeof (part as { textDelta?: unknown }).textDelta === 'string'
  );
}

function isCyberPolicyViolationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cyber_policy_violation/i.test(message);
}

export async function handleChatStreaming(
  res: Response,
  modelId: string,
  input: string,
  temperature?: number,
  maxTokens?: number,
  requestId?: string,
  safetyIdentifier?: string
): Promise<void> {
  const id = openAICompletionId();
  const created = nowSeconds();

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sendSSEChunk(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model: modelId,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant' },
        finish_reason: null
      }
    ]
  });

  const suppressionEnabled = process.env.STREAM_SUPPRESS_TOOLISH === '1';
  const pipeModelStream = async (activeModel: string): Promise<void> => {
    const streamResult = runWorkerTextStream({
      modelId: activeModel,
      input,
      temperature,
      maxTokens,
      requestId,
      safetyIdentifier,
      routeKind: 'chat'
    });

    let gating = suppressionEnabled;
    let preBuffer = '';

    for await (const part of streamResult.fullStream) {
      if (!isTextDeltaEvent(part)) {
        continue;
      }

      let delta = String(part.textDelta ?? '');
      if (!delta) {
        continue;
      }

      if (suppressionEnabled) {
        delta = delta.replace(/```/g, '');
      }

      if (gating) {
        preBuffer += delta;
        const trimmed = preBuffer.trim();

        if (trimmed.length > 220 || preBuffer.includes('\n') || !trimmed.startsWith('{')) {
          gating = false;
          if (preBuffer) {
            sendSSEChunk(res, {
              id,
              object: 'chat.completion.chunk',
              created,
              model: activeModel,
              choices: [
                {
                  index: 0,
                  delta: { content: preBuffer },
                  finish_reason: null
                }
              ]
            });
          }
          preBuffer = '';
          continue;
        }

        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          const looksToolCall =
            (typeof parsed.name === 'string' && Object.prototype.hasOwnProperty.call(parsed, 'arguments')) ||
            Object.prototype.hasOwnProperty.call(parsed, 'tool_calls');

          if (looksToolCall) {
            gating = false;
            preBuffer = '';
            sendSSEChunk(res, {
              id,
              object: 'chat.completion.chunk',
              created,
              model: activeModel,
              choices: [
                {
                  index: 0,
                  delta: {
                    content: 'Model output suppressed because it resembled a tool call payload.'
                  },
                  finish_reason: null
                }
              ]
            });
          }
        } catch {
          // Wait for additional tokens while gating.
        }

        continue;
      }

      sendSSEChunk(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model: activeModel,
        choices: [
          {
            index: 0,
            delta: { content: delta },
            finish_reason: null
          }
        ]
      });
    }
  };

  try {
    await pipeModelStream(modelId);
  } catch (error: unknown) {
    if (!isCyberPolicyViolationError(error)) {
      throw error;
    }

    const fallbackModel = getPolicyFallbackModel(modelId);
    if (fallbackModel === modelId) {
      throw error;
    }

    log.info('policy_trigger_event', {
      request_id: requestId ?? null,
      route_kind: 'chat',
      trigger: 'cyber_policy_violation',
      primary_model: modelId,
      fallback_model: fallbackModel,
      safety_identifier_present: Boolean(safetyIdentifier),
      fallback_attempted: true
    });

    try {
      await pipeModelStream(fallbackModel);
      log.info('policy_trigger_event', {
        request_id: requestId ?? null,
        route_kind: 'chat',
        trigger: 'cyber_policy_violation',
        primary_model: modelId,
        fallback_model: fallbackModel,
        fallback_attempted: true,
        fallback_success: true
      });
    } catch (fallbackError: unknown) {
      log.error('policy_trigger_event', {
        request_id: requestId ?? null,
        route_kind: 'chat',
        trigger: 'cyber_policy_violation',
        primary_model: modelId,
        fallback_model: fallbackModel,
        fallback_attempted: true,
        fallback_success: false,
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      });
      throw fallbackError;
    }
  }

  sendSSEChunk(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model: modelId,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'stop'
      }
    ]
  });

  res.write('data: [DONE]\n\n');
  res.end();
}
