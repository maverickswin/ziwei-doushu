/**
 * lib/sessions —— 排盘会话（命盘 + AI 对话）的本地持久化
 *
 * 和 lib/case-history（只存出生信息）分开：
 *   · case-history：一个人一条，给「从历史选择」快速填表用，很小。
 *   · sessions：一次排盘 = 一张命盘 + 一段对话，重开页面能接着聊，不用再花钱重新解读。
 *
 * 存储用 localStorage，容量约 5MB；命盘 JSON 约 8KB，对话按条数裁剪。
 * 写入失败（配额满）时自动淘汰最旧的会话，而不是静默丢数据。
 */

import type { ZiweiChart } from './ziwei/types';
import type { SavedCaseForm } from './case-history';
import { caseId } from './case-history';

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  hidden?: boolean;
}

export interface ChartSession {
  id: string;
  form: SavedCaseForm;
  /** 保存时快照的命盘；老数据缺失时会用 form 重新排 */
  chart: ZiweiChart | null;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface HemingThreadItem {
  question: string;
  answer: string;
}

export interface HemingSession {
  id: string;
  formA: SavedCaseForm;
  formB: SavedCaseForm;
  analysis: string;
  thread: HemingThreadItem[];
  createdAt: number;
  updatedAt: number;
}

const CHART_KEY = 'ziwei-chart-sessions-v1';
const HEMING_KEY = 'ziwei-heming-sessions-v1';

const MAX_CHART_SESSIONS = 20;
const MAX_HEMING_SESSIONS = 10;
const MAX_MESSAGES = 80;
/** 单条会话超过这个字符数就不存对话正文（只保留最近几条），避免写爆配额 */
const SESSION_CHAR_BUDGET = 220_000;

export function chartSessionId(form: SavedCaseForm): string {
  return caseId(form);
}

export function hemingSessionId(formA: SavedCaseForm, formB: SavedCaseForm): string {
  return `${caseId(formA)}__${caseId(formB)}`;
}

function isForm(value: unknown): value is SavedCaseForm {
  if (!value || typeof value !== 'object') return false;
  const f = value as Partial<SavedCaseForm>;
  return typeof f.year === 'string' && typeof f.month === 'string' && typeof f.day === 'string';
}

function isMessage(value: unknown): value is StoredMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as Partial<StoredMessage>;
  return (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string';
}

function readArray(key: string): unknown[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 裁剪到可写入为止：先丢最旧的会话，只剩一个时再砍对话条数 */
function persist<T>(key: string, list: T[], shrink: (items: T[]) => T[] | null): T[] {
  if (typeof window === 'undefined') return list;
  let current = list;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      window.localStorage.setItem(key, JSON.stringify(current));
      return current;
    } catch {
      const next = shrink(current);
      if (!next) break;
      current = next;
    }
  }
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 忽略
  }
  return [];
}

function trimMessages(messages: StoredMessage[]): StoredMessage[] {
  return messages.slice(-MAX_MESSAGES);
}

// ─── 命盘会话 ──────────────────────────────────────────────

export function loadChartSessions(): ChartSession[] {
  const list = readArray(CHART_KEY);
  const sessions: ChartSession[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Partial<ChartSession>;
    if (typeof s.id !== 'string' || !isForm(s.form)) continue;
    sessions.push({
      id: s.id,
      form: s.form,
      chart: (s.chart ?? null) as ZiweiChart | null,
      messages: Array.isArray(s.messages) ? s.messages.filter(isMessage).slice(-MAX_MESSAGES) : [],
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
    });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

function writeChartSessions(sessions: ChartSession[]): ChartSession[] {
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CHART_SESSIONS);
  return persist(CHART_KEY, sorted, (items) => {
    if (items.length > 1) return items.slice(0, items.length - 1);
    const only = items[0];
    if (!only || only.messages.length === 0) return null;
    return [{ ...only, messages: only.messages.slice(-10) }];
  });
}

/** 新建或覆盖一条会话（同一个人再次排盘时保留旧对话，除非显式传 messages） */
export function saveChartSession(input: {
  form: SavedCaseForm;
  chart: ZiweiChart;
  messages?: StoredMessage[];
}): ChartSession[] {
  const id = chartSessionId(input.form);
  const sessions = loadChartSessions();
  const existing = sessions.find((s) => s.id === id);
  const now = Date.now();
  const record: ChartSession = {
    id,
    form: input.form,
    chart: input.chart,
    messages: trimMessages(input.messages ?? existing?.messages ?? []),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return writeChartSessions([record, ...sessions.filter((s) => s.id !== id)]);
}

/** 局部更新（对话流式写入时用改这个，避免整张盘重复落盘） */
export function patchChartSession(
  id: string,
  patch: Partial<Pick<ChartSession, 'messages' | 'chart' | 'form'>>,
): ChartSession[] {
  const sessions = loadChartSessions();
  const index = sessions.findIndex((s) => s.id === id);
  if (index < 0) return sessions;
  const current = sessions[index];
  const next: ChartSession = {
    ...current,
    ...patch,
    messages: trimMessages(patch.messages ?? current.messages),
    updatedAt: Date.now(),
  };
  const rest = sessions.filter((s) => s.id !== id);
  return writeChartSessions([next, ...rest]);
}

export function removeChartSession(id: string): ChartSession[] {
  return writeChartSessions(loadChartSessions().filter((s) => s.id !== id));
}

/** 会话体积估算（字符数），用于提示 */
export function chartSessionWeight(session: ChartSession): number {
  const messages = session.messages.reduce((sum, m) => sum + m.content.length, 0);
  return (session.chart ? JSON.stringify(session.chart).length : 0) + messages;
}

// ─── 合盘会话 ──────────────────────────────────────────────

export function loadHemingSessions(): HemingSession[] {
  const list = readArray(HEMING_KEY);
  const sessions: HemingSession[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Partial<HemingSession>;
    if (typeof s.id !== 'string' || !isForm(s.formA) || !isForm(s.formB)) continue;
    sessions.push({
      id: s.id,
      formA: s.formA,
      formB: s.formB,
      analysis: typeof s.analysis === 'string' ? s.analysis : '',
      thread: Array.isArray(s.thread)
        ? s.thread
            .filter((t): t is HemingThreadItem =>
              Boolean(t) && typeof (t as HemingThreadItem).question === 'string'
              && typeof (t as HemingThreadItem).answer === 'string')
            .slice(-20)
        : [],
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
    });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

function writeHemingSessions(sessions: HemingSession[]): HemingSession[] {
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_HEMING_SESSIONS);
  return persist(HEMING_KEY, sorted, (items) => {
    if (items.length > 1) return items.slice(0, items.length - 1);
    const only = items[0];
    if (!only) return null;
    if (only.thread.length > 0) return [{ ...only, thread: [] }];
    if (only.analysis.length > 0) return [{ ...only, analysis: '', thread: [] }];
    return null;
  });
}

export function saveHemingSession(input: {
  formA: SavedCaseForm;
  formB: SavedCaseForm;
  analysis: string;
  thread: HemingThreadItem[];
}): HemingSession[] {
  const id = hemingSessionId(input.formA, input.formB);
  const sessions = loadHemingSessions();
  const existing = sessions.find((s) => s.id === id);
  const now = Date.now();
  const record: HemingSession = {
    id,
    formA: input.formA,
    formB: input.formB,
    analysis: input.analysis.slice(0, SESSION_CHAR_BUDGET),
    thread: input.thread.slice(-20),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return writeHemingSessions([record, ...sessions.filter((s) => s.id !== id)]);
}

export function removeHemingSession(id: string): HemingSession[] {
  return writeHemingSessions(loadHemingSessions().filter((s) => s.id !== id));
}
