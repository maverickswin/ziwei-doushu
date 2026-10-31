/**
 * lib/ai/client —— 浏览器侧的 SSE 读取工具
 *
 * 前端原来按 chunk.split('\n') 直接解析，一旦某个 data 行被网络切在两个 chunk 里，
 * JSON.parse 就会失败并静默丢掉这段文字。这里按行缓冲，保证不丢字。
 */

export interface AiErrorPayload {
  error?: string | { message?: string };
  code?: string;
}

function extractErrorMessage(payload: AiErrorPayload): string {
  if (typeof payload.error === 'string') return payload.error;
  if (payload.error && typeof payload.error.message === 'string') return payload.error.message;
  return '';
}

/**
 * 读取 /api/interpret、/api/heming 的流式响应。
 * @returns 完整文本
 */
export async function streamAiResponse(
  res: Response,
  onDelta: (text: string) => void,
): Promise<string> {
  if (!res.ok) {
    let message = `请求失败（HTTP ${res.status}）`;
    try {
      const payload = (await res.json()) as AiErrorPayload;
      const fromBody = extractErrorMessage(payload);
      if (fromBody) message = fromBody;
    } catch {
      // 非 JSON 错误体，保留默认文案
    }
    throw new Error(message);
  }
  if (!res.body) throw new Error('服务端没有返回响应流。');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  const handleLine = (rawLine: string): boolean => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('data:')) return false;
    const payload = line.slice(5).trim();
    if (!payload) return false;
    if (payload === '[DONE]') return true;
    try {
      const parsed = JSON.parse(payload) as {
        delta?: { text?: string };
        error?: string | { message?: string };
      };
      const errorMessage = extractErrorMessage(parsed as AiErrorPayload);
      if (errorMessage) throw new Error(errorMessage);
      const delta = parsed.delta?.text;
      if (typeof delta === 'string' && delta.length > 0) {
        full += delta;
        onDelta(delta);
      }
    } catch (err) {
      if (err instanceof SyntaxError) return false; // 非 JSON 行（注释/心跳）
      throw err;
    }
    return false;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (handleLine(line)) return full;
    }
  }

  // 流结束时若还有半行未处理，补一次
  if (buffer.trim()) handleLine(buffer);
  return full;
}
