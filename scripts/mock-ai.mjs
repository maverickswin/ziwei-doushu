/**
 * scripts/mock-ai.mjs —— 本地假的 OpenAI 兼容上游
 *
 * 用途：没有 API Key、或不想花钱调真模型时，验证 /api/interpret 与 /api/heming
 * 的流式链路、提示词组装和前端渲染。
 *
 * 用法：
 *   # 终端 1
 *   node scripts/mock-ai.mjs 18999
 *   # 终端 2（把 dev server 指到假上游）
 *   AI_PROVIDER=ollama AI_BASE_URL=http://127.0.0.1:18999/v1 AI_MODEL=mock npm run dev
 *
 * 每收到一次请求，会把完整的 messages 写到 scripts/.mock-captured/req-<n>.json，
 * 可以直接看模型最终收到的提示词。
 * 若请求的 model 为 mock-401，则返回 401，用来演示「Key 错误」的提示。
 */

import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const port = Number(process.argv[2] ?? 18999);
const outDir = join(dirname(fileURLToPath(import.meta.url)), '.mock-captured');
mkdirSync(outDir, { recursive: true });

let counter = 0;

const SAMPLE = [
  '**【示例输出·仅供链路验证】**\n',
  '这段文字来自 scripts/mock-ai.mjs，不是真实模型生成的解读。\n',
  '\n**【命格定性】**\n',
  '假上游固定返回这段文本，用来确认 SSE 分块、断行缓冲与前端渲染都正常。\n',
  '\n**【说明】**\n',
  '把 DEEPSEEK_API_KEY 填进 .env.local 并重启 dev server，就会换成真实模型。\n',
];

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const id = ++counter;
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
        writeFileSync(
          join(outDir, `req-${id}.json`),
          JSON.stringify({ model: parsed.model, messages: parsed.messages }, null, 2),
        );
        console.log(`[mock] #${id} model=${parsed.model} messages=${parsed.messages?.length} → ${join(outDir, `req-${id}.json`)}`);
      } catch {
        console.log(`[mock] #${id} 请求体不是 JSON`);
      }

      if (parsed?.model === 'mock-401') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Authentication Fails, Your api key is invalid' } }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const full = SAMPLE.join('');
      const step = Math.max(6, Math.ceil(full.length / 10));
      let index = 0;

      const tick = () => {
        if (index >= full.length) {
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        const piece = full.slice(index, index + step);
        index += step;
        const line = `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`;
        // 故意把一条 SSE 行拆成两半写出，验证服务端与浏览器的按行缓冲
        const cut = Math.floor(line.length / 2);
        res.write(line.slice(0, cut));
        setTimeout(() => {
          res.write(line.slice(cut));
          setTimeout(tick, 25);
        }, 15);
      };

      tick();
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock] 假上游已启动：http://127.0.0.1:${port}/v1`);
  console.log('[mock] 提示词落盘目录：scripts/.mock-captured/');
});
