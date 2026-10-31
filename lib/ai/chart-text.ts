/**
 * lib/ai/chart-text —— 把 ZiweiChart 序列化成给模型看的结构化中文文本
 *
 * 目标是「模型不用猜」：宫位、宫干、星曜、亮度、四化、自化、空宫借星、
 * 大限四化、流年四化、命中的格局，全部由引擎算好再写进提示词。
 * 模型只负责表达，不负责排盘。
 */

import 'server-only';
import type { DaXian, Palace, Star, ZiweiChart } from '@/lib/ziwei/types';
import { BRANCHES, SHICHEN, STAR_DESCRIPTIONS, STEMS } from '@/lib/ziwei/constants';
import { detectPatterns, getMingGongSummary, type Pattern } from '@/lib/ziwei/patterns';
import { getDaXianSiHua, getLiuNianSiHua, getYearBranchIndex } from '@/lib/ziwei/sihua';

const LUNAR_DAYS = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
];

const LUNAR_MONTHS = [
  '正月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '冬月', '腊月',
];

export function branchName(index: number | undefined): string {
  if (typeof index !== 'number' || index < 0 || index >= 12) return '—';
  return BRANCHES[index] ?? '—';
}

function stemName(index: number | undefined): string {
  if (typeof index !== 'number' || index < 0 || index >= 10) return '—';
  return STEMS[index] ?? '—';
}

function lunarDayName(day: number): string {
  return LUNAR_DAYS[day - 1] ?? `${day}`;
}

function lunarMonthName(month: number): string {
  const idx = Math.abs(month) - 1;
  const name = LUNAR_MONTHS[idx] ?? `${Math.abs(month)}月`;
  return month < 0 ? `闰${name}` : name;
}

/** 宫名本身可能已带「宫」字（命宫），统一补齐，避免出现「命宫宫」 */
export function palaceTitle(name: string): string {
  return name.endsWith('宫') ? name : `${name}宫`;
}

/**
 * 近 N 年的流年表：年份、干支、流年四化、流年命宫落在本命哪一宫。
 *
 * 有了这张表，模型才能回答「哪几年是节点」；没有它只能含糊其辞。
 * 多张盘（合盘）时合并成一行，共享干支与四化，只分别列出流年命宫。
 */
export function renderLiunianTable(
  charts: { label?: string; chart: ZiweiChart }[],
  startYear: number,
  count = 10,
): string {
  const rows: string[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const year = startYear + offset;
    const stem = getLiuNianSiHua(year);
    const branch = getYearBranchIndex(year);
    const transform = `禄:${stem.transforms.禄} 权:${stem.transforms.权} 科:${stem.transforms.科} 忌:${stem.transforms.忌}`;
    const palaces = charts.map(({ label, chart }) => {
      const palace = palaceOf(chart, branch);
      const name = palace ? palaceTitle(palace.name) : '—';
      return label ? `${label}：${name}` : name;
    }).join('　');
    const mark = offset === 0 ? ' ← 今年' : '';
    rows.push(`· ${year} ${stem.stemName}${branchName(branch)}年｜${transform}｜流年命宫 ${palaces}${mark}`);
  }
  return rows.join('\n');
}

function shichenName(hour: number): string {
  return SHICHEN[hour]?.name ?? '—';
}

function sihuaOf(star: Star): string {
  return star.siHua ? `化${star.siHua}` : '';
}

function starLabel(star: Star, withBrightness = true): string {
  const brightness = withBrightness && star.brightnessRaw ? `(${star.brightnessRaw})` : '';
  return `${star.name}${brightness}${sihuaOf(star)}`;
}

function palaceOf(chart: ZiweiChart, branch: number | undefined): Palace | undefined {
  return chart.palaces.find((p) => p.branch === branch);
}

/** 宫名归一化：引擎里 命宫 带「宫」字、其余（夫妻/财帛…）不带，比较时统一去掉 */
function normalizePalaceName(name: string): string {
  return name.replace(/宫$/, '');
}

export function palaceByName(chart: ZiweiChart, name: string): Palace | undefined {
  const target = normalizePalaceName(name);
  return chart.palaces.find((p) => normalizePalaceName(p.name) === target);
}

export function majorStarsIn(palace: Palace | undefined): Star[] {
  return palace?.stars.filter((s) => s.type === 'major') ?? [];
}

/** 生年四化的文字表示，按禄→权→科→忌排序 */
export function natalSiHuaText(chart: ZiweiChart): string {
  const order: Record<string, number> = { 禄: 0, 权: 1, 科: 2, 忌: 3 };
  const marks: { text: string; order: number }[] = [];
  for (const palace of chart.palaces) {
    for (const star of palace.stars) {
      if (star.siHua) marks.push({ text: `${star.name}化${star.siHua}`, order: order[star.siHua] ?? 9 });
    }
  }
  marks.sort((a, b) => a.order - b.order);
  return marks.length > 0 ? marks.map((m) => m.text).join('、') : '本盘生年四化无落星（异常，请核对）';
}

function transformText(transforms: Record<string, string> | undefined): string {
  if (!transforms) return '—';
  return (['禄', '权', '科', '忌'] as const)
    .filter((key) => transforms[key])
    .map((key) => `化${key}：${transforms[key]}`)
    .join('　');
}

function formatPalace(chart: ZiweiChart, palace: Palace): string {
  const lines: string[] = [];
  const ganZhi = `${stemName(palace.stem)}${branchName(palace.branch)}`;
  const tags: string[] = [];
  if (palace.isMingGong) tags.push('命宫');
  if (palace.isShenGong) tags.push('身宫');
  if (palace.isCurrentDaXian) tags.push('当前大限');
  const daXianAge = palace.daXianAge ? `大限 ${palace.daXianAge[0]}-${palace.daXianAge[1]} 岁` : '';
  const head = [
    `· ${palaceTitle(palace.name)}`,
    `（${ganZhi}）`,
    daXianAge,
    tags.length > 0 ? `［${tags.join('·')}］` : '',
  ].filter(Boolean).join('');

  const major = palace.stars.filter((s) => s.type === 'major');
  const lucky = palace.stars.filter((s) => s.type === 'lucky');
  const sha = palace.stars.filter((s) => s.type === 'sha');
  const minor = palace.stars.filter((s) => s.type === 'minor');

  lines.push(head);
  lines.push(`　主星：${major.length > 0 ? major.map((s) => starLabel(s)).join('、') : '无主星（空宫）'}`);
  if (lucky.length > 0) lines.push(`　吉星：${lucky.map((s) => starLabel(s, false)).join('、')}`);
  if (sha.length > 0) lines.push(`　煞星：${sha.map((s) => starLabel(s, false)).join('、')}`);
  if (minor.length > 0) lines.push(`　杂曜：${minor.map((s) => starLabel(s, false)).join('、')}`);

  if (palace.isEmpty) {
    const borrowed = palace.borrowedStars?.length
      ? palace.borrowedStars.join('、')
      : '对宫主星';
    lines.push(`　空宫：借对宫${palace.borrowedFromName ? `（${palace.borrowedFromName}）` : ''}${borrowed}`);
  }

  if (palace.selfSihua?.length) {
    lines.push(`　宫干自化：${palace.selfSihua.map((s) => `${s.starName}化${s.siHua}`).join('、')}`);
  }

  const opposite = palaceOf(chart, palace.oppositeBranch ?? (palace.branch + 6) % 12);
  if (opposite) lines.push(`　对宫：${palaceTitle(opposite.name)}（${branchName(opposite.branch)}）`);

  return lines.join('\n');
}

function formatDaXian(chart: ZiweiChart, daXian: DaXian, index: number): string {
  const siHua = getDaXianSiHua(chart, index);
  const age = `${String(daXian.startAge).padStart(2, '0')}-${String(daXian.endAge).padStart(2, '0')}`;
  const palace = palaceOf(chart, daXian.palaceBranch);
  const ganZhi = palace ? `${stemName(palace.stem)}${branchName(palace.branch)}` : branchName(daXian.palaceBranch);
  const isCurrent = index === chart.currentDaXianIndex;
  const marks = [isCurrent ? ' ← 当前' : ''].join('');
  return `· ${age} 岁｜${palaceTitle(daXian.palaceName)}（${ganZhi}）｜四化：${transformText(siHua?.transforms)}${marks}`;
}

function formatPatterns(patterns: Pattern[], limit = 10): string {
  if (patterns.length === 0) return '（未命中本库收录的成格条件，按主星性质与三方四正论）';
  return patterns.slice(0, limit).map((p) => {
    const level = p.level === 'excellent' ? '上格' : p.level === 'good' ? '吉格' : p.level === 'caution' ? '警戒格' : '中格';
    const parts = [`· ${p.name}（${level}）：${p.description}`];
    if (p.conditions?.breaking?.length) parts.push(`　破格：${p.conditions.breaking.join('；')}`);
    if (p.source) parts.push(`　出处：${p.source}`);
    return parts.join('\n');
  }).join('\n');
}

export interface ChartTextOptions {
  /** 流年所属公历年，默认当前年 */
  liunianYear?: number;
  /** 是否附格局，默认 true */
  includePatterns?: boolean;
}

/** 完整命盘文本（用于 /api/interpret） */
export function renderChartForPrompt(chart: ZiweiChart, opts: ChartTextOptions = {}): string {
  const year = opts.liunianYear ?? new Date().getFullYear();
  const { birthInfo, lunarInfo } = chart;
  const hourIndex = birthInfo.hour;
  const solarDate = `${birthInfo.year}-${String(birthInfo.month).padStart(2, '0')}-${String(birthInfo.day).padStart(2, '0')}`;
  const lunarDate = `${stemName(lunarInfo.yearStem)}${branchName(lunarInfo.yearBranch)}年`
    + ` ${lunarMonthName(lunarInfo.lunarMonth)}`
    + `${lunarDayName(lunarInfo.lunarDay)}`;
  const place = birthInfo.city || birthInfo.province
    ? `${birthInfo.province ?? ''}${birthInfo.city ?? ''}`
    : '未填写出生地';
  const longitudeNote = birthInfo.longitude != null
    ? `经度 ${birthInfo.longitude}`
    : '无经度';

  const blocks: string[] = [];

  blocks.push([
    '【命主输入】',
    `性别：${birthInfo.gender === 'male' ? '男' : '女'}（${chart.yinYangGender ?? '阴阳未标'}）`,
    `公历：${solarDate} ${shichenName(hourIndex)}（时辰索引 ${hourIndex}，${SHICHEN[hourIndex]?.range ?? ''}）`,
    `农历：${lunarDate}${lunarInfo.isLeapMonth ? '（闰月）' : ''}`,
    lunarInfo.fourPillars ? `节气四柱：${lunarInfo.fourPillars.join(' ')}` : '',
    `出生地：${place}（${longitudeNote}）`,
    `五行局：${chart.wuxingJuName}｜命主星：${chart.mingZhu ?? '—'}｜身主星：${chart.shenZhu ?? '—'}`,
    `命宫：${branchName(chart.mingGongBranch)}｜身宫：${branchName(chart.shenGongBranch)}`,
  ].filter(Boolean).join('\n'));

  blocks.push(`【生年四化】\n${natalSiHuaText(chart)}`);

  const ming = palaceOf(chart, chart.mingGongBranch);
  if (ming) {
    const sanFang = [-4, 4].map((offset) => palaceOf(chart, (ming.branch + offset + 12) % 12));
    const opposite = palaceOf(chart, (ming.branch + 6) % 12);
    const names = [...sanFang, opposite]
      .filter((p): p is Palace => Boolean(p))
      .map((p) => `${palaceTitle(p.name)}（${branchName(p.branch)}）`);
    blocks.push(`【命宫三方四正】\n${names.join('、')}`);
  }

  blocks.push(`【十二宫】\n${chart.palaces
    .slice()
    .sort((a, b) => a.branch - b.branch)
    .map((p) => formatPalace(chart, p))
    .join('\n')}`);

  blocks.push(`【大限与四化】\n${chart.daXians.map((dx, i) => formatDaXian(chart, dx, i)).join('\n')}`);

  const liunianStem = getLiuNianSiHua(year);
  const liunianBranch = getYearBranchIndex(year);
  const liunianPalace = palaceOf(chart, liunianBranch);
  blocks.push([
    '【当前时间】',
    `流年：${year} 年（${liunianStem.stemName}${branchName(liunianBranch)}年）`,
    `流年四化：${transformText(liunianStem.transforms)}`,
    `流年命宫落本命：${liunianPalace ? `${palaceTitle(liunianPalace.name)}（${branchName(liunianPalace.branch)}）` : '—'}`,
    `当前大限：${chart.daXians[chart.currentDaXianIndex]
      ? `${chart.daXians[chart.currentDaXianIndex].startAge}-${chart.daXians[chart.currentDaXianIndex].endAge} 岁 / ${chart.daXians[chart.currentDaXianIndex].palaceName}宫`
      : '童限或未起运'}`,
    `当前虚岁：${chart.currentAge}`,
  ].join('\n'));

  blocks.push(`【近十年流年】\n${renderLiunianTable([{ chart }], year, 10)}`);

  if (opts.includePatterns !== false) {
    blocks.push(`【引擎命中的格局】\n${formatPatterns(detectPatterns(chart))}`);
  }

  const summary = getMingGongSummary(chart);
  if (summary.stars.length > 0) {
    blocks.push(`【命宫主星摘要】\n主星：${summary.stars.join('、')}｜关键词：${summary.keywords.join('、')}｜性质：${summary.nature}`);
  }

  return blocks.join('\n\n');
}

/** 精简命盘文本（用于合盘：只取婚姻相关宫位） */
export function renderChartBrief(chart: ZiweiChart, label: string): string {
  const { birthInfo, lunarInfo } = chart;
  const wanted = ['命宫', '夫妻宫', '福德宫', '财帛宫', '官禄宫', '迁移宫'];
  const lines: string[] = [];

  lines.push(`【${label}】`);
  lines.push(
    `${birthInfo.gender === 'male' ? '男' : '女'}（${chart.yinYangGender ?? '阴阳未标'}）`
    + `｜公历 ${birthInfo.year}-${String(birthInfo.month).padStart(2, '0')}-${String(birthInfo.day).padStart(2, '0')}`
    + ` ${shichenName(birthInfo.hour)}`
    + `｜农历 ${stemName(lunarInfo.yearStem)}${branchName(lunarInfo.yearBranch)}年 ${lunarMonthName(lunarInfo.lunarMonth)}`
    + `｜${chart.wuxingJuName}`
    + `｜命宫 ${branchName(chart.mingGongBranch)}`,
  );
  lines.push(`生年四化：${natalSiHuaText(chart)}`);

  for (const name of wanted) {
    const palace = palaceByName(chart, name);
    if (!palace) continue;
    const major = majorStarsIn(palace);
    const stars = major.length > 0
      ? major.map((s) => starLabel(s)).join('、')
      : `空宫（借${palace.borrowedFromName ?? '对宫'}：${palace.borrowedStars?.join('、') ?? '—'}）`;
    const sha = palace.stars.filter((s) => s.type === 'sha').map((s) => s.name);
    const lucky = palace.stars.filter((s) => s.type === 'lucky').map((s) => s.name);
    const extras = [
      sha.length > 0 ? `煞：${sha.join('、')}` : '',
      lucky.length > 0 ? `吉：${lucky.join('、')}` : '',
    ].filter(Boolean).join('｜');
    lines.push(`· ${name}（${stemName(palace.stem)}${branchName(palace.branch)}）：${stars}${extras ? `｜${extras}` : ''}`);
  }

  const currentDx = chart.daXians[chart.currentDaXianIndex];
  if (currentDx) {
    const siHua = getDaXianSiHua(chart, chart.currentDaXianIndex);
    lines.push(
      `当前大限：${currentDx.startAge}-${currentDx.endAge} 岁 / ${palaceTitle(currentDx.palaceName)}`
      + `｜四化 ${transformText(siHua?.transforms)}`,
    );
  }

  return lines.join('\n');
}

/** 取某宫的简要星情（给提示词里点名宫位用） */
export function palaceStarsText(chart: ZiweiChart, palaceName: string): string {
  const palace = palaceByName(chart, palaceName);
  if (!palace) return '';
  const major = majorStarsIn(palace);
  const sha = palace.stars.filter((s) => s.type === 'sha');
  return [
    major.length > 0 ? major.map((s) => starLabel(s)).join('、') : '空宫',
    sha.length > 0 ? `煞：${sha.map((s) => s.name).join('、')}` : '',
  ].filter(Boolean).join('｜');
}

/** 某主星的释义条目（来自 constants 的通用星情表） */
export function starDescriptionText(starName: string): string {
  const desc = STAR_DESCRIPTIONS[starName];
  if (!desc) return '';
  return `${starName}：关键词 ${desc.keywords}；性质 ${desc.nature}；五行 ${desc.element}`;
}
