/**
 * lib/ai/http —— 路由共用的校验与 SSE 包装
 *
 * 独立成模块的原因：Next.js 的 route.ts 只允许导出 HTTP 方法和有限配置，
 * 把工具函数放在路由文件里会导致构建期类型校验失败。
 */

import 'server-only';
import { AiUpstreamError, type ChatMessage } from './stream';
import type { ZiweiChart } from '@/lib/ziwei/types';

export const MAX_MESSAGES = 24;
export const MAX_CONTENT_CHARS = 4000;

export function jsonError(message: string, status: number, code: string): Response {
  return Response.json({ error: message, code }, { status });
}

export function isValidChart(value: unknown): value is ZiweiChart {
  if (!value || typeof value !== 'object') return false;
  const chart = value as Partial<ZiweiChart>;
  return Boolean(
    chart.birthInfo
    && typeof chart.birthInfo === 'object'
    && chart.lunarInfo
    && typeof chart.lunarInfo === 'object'
    && Array.isArray(chart.palaces)
    && chart.palaces.length === 12
    && Array.isArray(chart.daXians)
    && typeof chart.mingGongBranch === 'number'
    && typeof chart.shenGongBranch === 'number',
  );
}

export function sanitizeMessages(value: unknown): ChatMessage[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const cleaned: ChatMessage[] = [];
  for (const item of value.slice(-MAX_MESSAGES)) {
    if (!item || typeof item !== 'object') return null;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role !== 'user' && role !== 'assistant' && role !== 'system') return null;
    if (typeof content !== 'string') return null;
    if (role === 'system') continue; // 前端不许注入系统提示词
    if (!content.trim()) continue;
    cleaned.push({ role, content: content.slice(0, MAX_CONTENT_CHARS) });
  }
  return cleaned.length > 0 ? cleaned : null;
}

/** 把异步增量包成浏览器侧可读的 SSE 响应 */
export function sseResponse(run: (send: (payload: unknown) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(chunk));
      };
      const send = (payload: unknown) => write(`data: ${JSON.stringify(payload)}\n\n`);
      try {
        await run(send);
        write('data: [DONE]\n\n');
      } catch (err) {
        const message = err instanceof AiUpstreamError
          ? err.message
          : err instanceof Error ? err.message : '解读生成失败，请稍后重试。';
        send({ error: { message } });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // 客户端已断开
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
