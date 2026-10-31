/**
 * lib/ai/config —— AI 供应商配置（OpenAI 兼容协议）
 *
 * 只读环境变量，不做任何 IO。密钥只在服务端使用，绝不下发到浏览器。
 *
 * 变量优先级（从高到低）：
 *   AI_PROVIDER      选择预设：deepseek（默认）/ mimo / openai / ollama / 任意自定义名
 *   AI_BASE_URL      覆盖预设的接口地址（须含 /v1，或以 /chat/completions 结尾）
 *   AI_MODEL         覆盖预设的模型名
 *   AI_API_KEY       覆盖预设的密钥变量
 *   <PRESET>_API_KEY 预设自带的密钥变量，如 DEEPSEEK_API_KEY
 *
 * 另有两个可选调参：AI_MAX_TOKENS（默认 2048）、AI_TEMPERATURE（默认 0.7）。
 */

import 'server-only';

export interface AiConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigError';
  }
}

interface Preset {
  /** 保存密钥的环境变量名；空字符串表示该预设不需要密钥（本地模型） */
  apiKeyEnv: string;
  baseUrl: string;
  model: string;
  requiresKey: boolean;
}

const PRESETS: Record<string, Preset> = {
  deepseek: {
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    requiresKey: true,
  },
  // 小米 MiMo 等自建/第三方网关：地址与模型名都必须由环境变量给出
  mimo: {
    apiKeyEnv: 'MIMO_API_KEY',
    baseUrl: '',
    model: '',
    requiresKey: true,
  },
  openai: {
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    requiresKey: true,
  },
  ollama: {
    apiKeyEnv: '',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:14b',
    requiresKey: false,
  },
};

function firstNonEmpty(...values: (string | undefined)[]): string {
  for (const v of values) {
    const trimmed = v?.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function toNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 规范化为「…/v1」形式；调用方再拼 /chat/completions */
export function normalizeBaseUrl(input: string): string {
  const url = input.trim().replace(/\/+$/, '');
  // 允许用户直接粘贴完整的 completions 地址
  return url.replace(/\/chat\/completions$/, '');
}

export function resolveAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const provider = (env.AI_PROVIDER || 'deepseek').trim().toLowerCase() || 'deepseek';
  const preset = PRESETS[provider] ?? {
    apiKeyEnv: '',
    baseUrl: '',
    model: '',
    requiresKey: true,
  };

  const baseUrl = normalizeBaseUrl(firstNonEmpty(
    env.AI_BASE_URL,
    provider === 'mimo' ? env.MIMO_BASE_URL : '',
    preset.baseUrl,
  ));
  if (!baseUrl) {
    throw new AiConfigError(
      `AI_PROVIDER=${provider} 需要设置接口地址：请在 .env.local 填写 AI_BASE_URL`
      + (provider === 'mimo' ? '（或 MIMO_BASE_URL）' : '') + '。',
    );
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new AiConfigError(`AI_BASE_URL 必须以 http:// 或 https:// 开头，当前为「${baseUrl}」。`);
  }

  const model = firstNonEmpty(
    env.AI_MODEL,
    provider === 'mimo' ? env.MIMO_MODEL : '',
    preset.model,
  );
  if (!model) {
    throw new AiConfigError(
      `AI_PROVIDER=${provider} 需要设置模型名：请在 .env.local 填写 AI_MODEL`
      + (provider === 'mimo' ? '（或 MIMO_MODEL）' : '') + '。',
    );
  }

  const apiKey = firstNonEmpty(
    env.AI_API_KEY,
    preset.apiKeyEnv ? env[preset.apiKeyEnv] : '',
  );
  if (preset.requiresKey && !apiKey) {
    const keyName = preset.apiKeyEnv || 'AI_API_KEY';
    throw new AiConfigError(
      `缺少 API Key：请在 .env.local 设置 ${keyName}（或通用变量 AI_API_KEY）后重启 dev server。`,
    );
  }

  return {
    provider,
    apiKey,
    baseUrl,
    model,
    maxTokens: Math.trunc(toNumber(env.AI_MAX_TOKENS, 2048, 256, 8192)),
    temperature: toNumber(env.AI_TEMPERATURE, 0.7, 0, 2),
    timeoutMs: Math.trunc(toNumber(env.AI_TIMEOUT_MS, 120_000, 5_000, 600_000)),
  };
}

/** 给前端/日志用的脱敏描述（不含密钥） */
export function describeAiConfig(config: AiConfig): string {
  return `${config.provider} / ${config.model} @ ${config.baseUrl}`;
}
