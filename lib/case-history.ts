/**
 * lib/case-history —— 最近排过的出生信息（localStorage）
 *
 * 目的：同一个例子反复排盘 / 反复合盘时，不用每次重填出生年月日时。
 * 只存出生信息，不存命盘和解读（命盘可以随时重算，解读牵扯隐私与体积）。
 *
 * 浏览器端专用；SSR 阶段调用 loadCases() 会返回空数组。
 */

export interface SavedCaseForm {
  name: string;
  year: string;
  month: string;
  day: string;
  clockHour: string;
  clockMinute: string;
  unknownTime: boolean;
  province: string;
  city: string;
  longitude: number;
  gender: 'male' | 'female';
}

export interface SavedCase {
  id: string;
  form: SavedCaseForm;
  savedAt: number;
}

const STORAGE_KEY = 'ziwei-cases-v1';
const MAX_CASES = 12;

export function caseId(form: SavedCaseForm): string {
  return [
    form.year, form.month, form.day,
    form.unknownTime ? '?' : `${form.clockHour}:${form.clockMinute}`,
    form.gender,
    (form.name ?? '').trim(),
  ].join('|');
}

function isCase(value: unknown): value is SavedCase {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<SavedCase>;
  return typeof c.id === 'string'
    && typeof c.savedAt === 'number'
    && Boolean(c.form)
    && typeof c.form === 'object'
    && typeof (c.form as SavedCaseForm).year === 'string'
    && typeof (c.form as SavedCaseForm).gender === 'string';
}

export function loadCases(): SavedCase[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCase).slice(0, MAX_CASES);
  } catch {
    return [];
  }
}

function persist(cases: SavedCase[]): SavedCase[] {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cases));
    } catch {
      // 隐私模式/配额满：忽略，不影响排盘
    }
  }
  return cases;
}

/** 保存一条（同一个人重复保存只更新时间与信息，不重复占位） */
export function saveCase(form: SavedCaseForm): SavedCase[] {
  const id = caseId(form);
  const rest = loadCases().filter((c) => c.id !== id);
  return persist([{ id, form: { ...form }, savedAt: Date.now() }, ...rest].slice(0, MAX_CASES));
}

export function removeCase(id: string): SavedCase[] {
  return persist(loadCases().filter((c) => c.id !== id));
}

export function clearCases(): SavedCase[] {
  return persist([]);
}

/** 列表里显示的一行文字：张三 · 1990-06-15 08:00 · 男 */
export function formatCaseLabel(c: SavedCase): string {
  const f = c.form;
  const date = `${f.year}-${String(f.month).padStart(2, '0')}-${String(f.day).padStart(2, '0')}`;
  const time = f.unknownTime ? '时辰未知' : `${String(f.clockHour).padStart(2, '0')}:${String(f.clockMinute).padStart(2, '0')}`;
  const place = f.city || f.province;
  return [f.name?.trim() || '未命名', `${date} ${time}`, f.gender === 'male' ? '男' : '女', place]
    .filter(Boolean)
    .join(' · ');
}
