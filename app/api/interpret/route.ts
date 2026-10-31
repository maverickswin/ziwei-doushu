/**
 * POST /api/interpret —— 命盘 AI 解读（流式）
 *
 * 请求：{ chart: ZiweiChart, messages: {role, content}[] }
 * 响应：text/event-stream
 *   data: {"delta":{"text":"…"}}
 *   data: {"error":{"message":"…"}}   ← 生成中途失败
 *   data: [DONE]
 *
 * 密钥只在服务端读取，浏览器拿不到。
 */

import { AiConfigError, describeAiConfig, resolveAiConfig } from '@/lib/ai/config';
import { buildInterpretMessages } from '@/lib/ai/prompts';
import { jsonError, isValidChart, sanitizeMessages, sseResponse } from '@/lib/ai/http';
import { streamChatCompletion } from '@/lib/ai/stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

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

  const { chart, messages } = (body ?? {}) as { chart?: unknown; messages?: unknown };
  if (!isValidChart(chart)) {
    return jsonError('命盘数据不完整：缺少 birthInfo / lunarInfo / 12 个宫位 / daXians。', 400, 'bad-chart');
  }
  const safeMessages = sanitizeMessages(messages);
  if (!safeMessages) {
    return jsonError('messages 必须是非空数组，元素形如 { role: "user", content: "…" }。', 400, 'bad-messages');
  }

  let payloadMessages;
  try {
    payloadMessages = buildInterpretMessages({ chart, messages: safeMessages });
  } catch (err) {
    return jsonError(
      `组装提示词失败：${err instanceof Error ? err.message : String(err)}`,
      400,
      'prompt-build-failed',
    );
  }

  if (process.env.NODE_ENV !== 'production') {
    console.info(`[interpret] ${describeAiConfig(config)}，消息 ${payloadMessages.length} 条`);
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
