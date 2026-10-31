/**
 * POST /api/heming —— 双人合盘分析（流式）
 *
 * 请求：{ chartA: ZiweiChart, chartB: ZiweiChart, question?: string }
 * 响应：与 /api/interpret 相同的 SSE 协议。
 */

import { AiConfigError, describeAiConfig, resolveAiConfig } from '@/lib/ai/config';
import { buildHemingMessages } from '@/lib/ai/prompts';
import { jsonError, isValidChart, sseResponse } from '@/lib/ai/http';
import { streamChatCompletion, type ChatMessage } from '@/lib/ai/stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MAX_QUESTION_CHARS = 500;
const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_CHARS = 6000;

/** 追问历史：只收 user/assistant，system 一律丢弃，避免前端注入 */
function sanitizeHistory(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const cleaned: ChatMessage[] = [];
  for (const item of value.slice(-MAX_HISTORY_TURNS)) {
    if (!item || typeof item !== 'object') continue;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role !== 'user' && role !== 'assistant') continue;
    if (typeof content !== 'string' || !content.trim()) continue;
    cleaned.push({ role, content: content.slice(0, MAX_HISTORY_CHARS) });
  }
  return cleaned;
}

export async function POST(req: Request) {
  let config;
  try {
    config = resolveAiConfig();
  } catch (err) {
    if (err instanceof AiConfigError) {
      return jsonError(err.message, 503, 'ai-not-configured');
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('请求体不是合法 JSON。', 400, 'bad-json');
  }

  const { chartA, chartB, question, history } = (body ?? {}) as {
    chartA?: unknown;
    chartB?: unknown;
    question?: unknown;
    history?: unknown;
  };
  if (!isValidChart(chartA) || !isValidChart(chartB)) {
    return jsonError('需要两份完整命盘：chartA 与 chartB 各含 birthInfo / lunarInfo / 12 个宫位 / daXians。', 400, 'bad-chart');
  }
  if (question !== undefined && question !== null && typeof question !== 'string') {
    return jsonError('question 必须是字符串。', 400, 'bad-question');
  }
  const safeQuestion = typeof question === 'string' ? question.trim().slice(0, MAX_QUESTION_CHARS) : '';
  const safeHistory = sanitizeHistory(history);

  let payloadMessages;
  try {
    payloadMessages = buildHemingMessages({
      chartA,
      chartB,
      question: safeQuestion || undefined,
      history: safeHistory,
    });
  } catch (err) {
    return jsonError(
      `组装提示词失败：${err instanceof Error ? err.message : String(err)}`,
      400,
      'prompt-build-failed',
    );
  }

  if (process.env.NODE_ENV !== 'production') {
    console.info(
      `[heming] ${describeAiConfig(config)}，模式：${safeHistory.length > 0 ? '追问' : '首次'}`
      + `，历史 ${safeHistory.length} 条，追问：${safeQuestion || '无'}`,
    );
  }

  return sseResponse(async (send) => {
    for await (const delta of streamChatCompletion({
      config,
      messages: payloadMessages,
      signal: req.signal,
    })) {
      send({ delta: { text: delta } });
    }
  });
}
