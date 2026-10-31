/**
 * 回归：浏览器侧 SSE 解析（lib/ai/client.ts）
 *
 * 这层曾经的写法是 chunk.split('\n') 直接解析，一条 data 行被网络切成两半时
 * JSON.parse 失败 → 静默丢字。本测试锁住三个行为：
 *   1. 行被拆到两个 chunk 里仍能拼回完整 delta；
 *   2. 收到 data: [DONE] 就结束，不把后续内容算进去；
 *   3. 服务端发来的 error 事件会抛错（前端据此把原因显示给用户），
 *      而 HTTP 非 2xx 的 JSON 错误体也要把 message 抛出来。
 */
import { streamAiResponse } from '../../lib/ai/client';

let fails = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) fails++;
}

function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    ...init,
  });
}

async function main() {
  // 1) 一条 SSE 行被拆成三段
  {
    const line = `data: ${JSON.stringify({ delta: { text: '命宫主星' } })}\n\n`;
    const cut1 = 10;
    const cut2 = 30;
    const chunks = [line.slice(0, cut1), line.slice(cut1, cut2), line.slice(cut2)];
    const seen: string[] = [];
    const full = await streamAiResponse(sseResponse(chunks), (d) => seen.push(d));
    ok('跨 chunk 的行不丢字：完整文本正确', full === '命宫主星');
    ok('跨 chunk 的行不丢字：增量回调只触发一次', seen.length === 1 && seen[0] === '命宫主星');
  }

  // 2) 多段增量 + [DONE] 之后的垃圾内容应被忽略
  {
    const chunks = [
      `data: ${JSON.stringify({ delta: { text: '甲' } })}\n\n`,
      `data: ${JSON.stringify({ delta: { text: '乙' } })}\n\ndata: [DONE]\n\n`,
      `data: ${JSON.stringify({ delta: { text: '不该出现' } })}\n\n`,
    ];
    const full = await streamAiResponse(sseResponse(chunks), () => {});
    ok('[DONE] 之后的内容被忽略', full === '甲乙');
  }

  // 3) 服务端 error 事件 → 抛错且带上原因
  {
    const chunks = [
      `data: ${JSON.stringify({ delta: { text: '开头' } })}\n\n`,
      `data: ${JSON.stringify({ error: { message: 'API Key 被拒绝' } })}\n\n`,
    ];
    let caught = '';
    try {
      await streamAiResponse(sseResponse(chunks), () => {});
    } catch (err) {
      caught = err instanceof Error ? err.message : String(err);
    }
    ok('error 事件抛出可读原因', caught === 'API Key 被拒绝');
  }

  // 4) HTTP 503 + JSON 错误体 → 抛出其中的 message
  {
    let caught = '';
    try {
      await streamAiResponse(
        Response.json({ error: '缺少 API Key：请设置 DEEPSEEK_API_KEY', code: 'ai-not-configured' }, { status: 503 }),
        () => {},
      );
    } catch (err) {
      caught = err instanceof Error ? err.message : String(err);
    }
    ok('非 2xx 的 JSON 错误体透传 message', caught.includes('DEEPSEEK_API_KEY'));
  }

  // 5) 心跳/注释行与空行不影响解析
  {
    const chunks = [': keep-alive\n\n', `data: ${JSON.stringify({ delta: { text: '丙' } })}\n\n`, '\n'];
    const full = await streamAiResponse(sseResponse(chunks), () => {});
    ok('注释行与空行被跳过', full === '丙');
  }

  console.log(fails === 0 ? '\n[sse-client] 全部通过' : `\n[sse-client] ${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
