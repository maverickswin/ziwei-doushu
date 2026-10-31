/**
 * lib/ai/stream —— OpenAI 兼容 Chat Completions 的流式客户端
 *
 * 只实现本项目需要的最小面：text 增量、错误映射、超时与中断。
 * 不引第三方 SDK，避免多供应商之间协议差异。
 */

import 'server-only';
import type { AiConfig } from './config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class AiUpstreamError extends Error {
  status: number;
  code: string;

  constructor(message: string, opts: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'AiUpstreamError';
    this.status = opts.status ?? 0;
    this.code = opts.code ?? 'upstream-error';
  }
}

function friendlyHttpError(status: number, provider: string, detail: string): string {
  if (status === 401 || status === 403) {
    return `API Key 被 ${provider} 拒绝（HTTP ${status}）。请确认 Key 正确、未过期且有权使用该模型。${detail}`;
  }
  if (status === 404) {
    return `接口地址或模型不存在（HTTP 404）。请检查 AI_BASE_URL 是否包含 /v1、AI_MODEL 是否拼写正确。${detail}`;
  }
  if (status === 429) {
    return `上游触发限流或余额不足（HTTP 429），请稍后重试。${detail}`;
  }
  if (status >= 500) {
    return `上游服务异常（HTTP ${status}），请稍后重试。${detail}`;
  }
  return `上游返回 HTTP ${status}。${detail}`;
}

async function readErrorDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 500);
    if (!text) return '';
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string };
      const msg = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
      return msg ? `上游信息：${msg}` : `上游信息：${text}`;
    } catch {
      return `上游信息：${text}`;
    }
  } catch {
    return '';
  }
}

/**
 * 逐块产出正文增量。调用方负责把它包成 SSE 给浏览器。
 * 上游 [DONE] 之后直接结束；被中断时不抛错，正常收尾。
 */
export async function* streamChatCompletion(opts: {
  config: AiConfig;
  messages: ChatMessage[];
  signal?: AbortSignal;
}): AsyncGenerator<string> {
  const { config, messages } = opts;
  const url = `${config.baseUrl}/chat/completions`;

  const signals: AbortSignal[] = [AbortSignal.timeout(config.timeoutMs)];
  if (opts.signal) signals.push(opts.signal);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
      }),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (opts.signal?.aborted) return;
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new AiUpstreamError(`上游超过 ${Math.round(config.timeoutMs / 1000)} 秒未响应，已中断。`, {
        code: 'timeout',
      });
    }
    throw new AiUpstreamError(
      `无法连接 ${config.baseUrl}：${err instanceof Error ? err.message : String(err)}`,
      { code: 'network' },
    );
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new AiUpstreamError(friendlyHttpError(res.status, config.provider, detail), {
      status: res.status,
      code: 'http',
    });
  }
  if (!res.body) {
    throw new AiUpstreamError('上游没有返回响应流（可能是非流式网关）。', { code: 'no-body' });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 的 data 行不会跨行，按 \n 切即可
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');

        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') return;

        try {
          const parsed = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) yield delta;
        } catch {
          // 忽略心跳/非 JSON 行
        }
      }
    }
  } catch (err) {
    if (opts.signal?.aborted) return;
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new AiUpstreamError('上游响应中途超时，已中断。', { code: 'timeout' });
    }
    throw new AiUpstreamError(
      `读取上游响应流失败：${err instanceof Error ? err.message : String(err)}`,
      { code: 'stream' },
    );
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 已关闭
    }
  }
}
