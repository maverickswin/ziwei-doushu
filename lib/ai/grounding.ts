/**
 * lib/ai/grounding —— 从仓库自带的资料里捞「有据可依」的原文塞进提示词
 *
 * 三个来源：
 *   1. 古籍原典（lib/classics）：《紫微斗数全书》《全集》《骨髓赋》原文段落
 *   2. 倪师讲义（lib/nihai）：天纪紫微模块要点 + 核心语录
 *   3. 星曜释义（lib/ziwei/constants）：十四主星的通用星情
 *
 * 检索是纯子串匹配（中文够用），结果做长度截断，保证提示词不会失控。
 */

import 'server-only';
import type { ZiweiChart } from '@/lib/ziwei/types';
import { searchClassics, type SearchHit } from '@/lib/classics';
import { TIANJI_MODULES, TIANJI_QUOTES } from '@/lib/nihai';
import {
  MARRIAGE_STARS_BRIEF,
  SIHUA_IN_FUQI_GU,
  STAR_IN_FUQI_GU,
} from '@/lib/ziwei/heming-knowledge';
import {
  majorStarsIn,
  natalSiHuaText,
  palaceByName,
  palaceTitle,
  starDescriptionText,
} from './chart-text';

const MAX_CLASSICS_HITS = 5;
const PARAGRAPH_LIMIT = 150;
const MAX_QUOTES = 6;

function trim(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

/** 从问题里抠出可用于检索的命理关键词 */
function questionKeywords(question: string): string[] {
  const dict = [
    '感情', '婚姻', '夫妻', '恋爱', '桃花', '配偶',
    '事业', '工作', '官禄', '升迁', '创业', '合伙',
    '财运', '财富', '财帛', '投资', '破财',
    '健康', '疾厄', '疾病', '身体',
    '性格', '命格', '格局', '子女', '父母', '兄弟', '朋友', '田宅', '房产',
    '大限', '流年', '运势', '化禄', '化权', '化科', '化忌', '四化',
  ];
  return dict.filter((k) => question.includes(k));
}

/** 问题里的关键词 → 语录 topic 的粗映射 */
function quoteTopicsFor(question: string): string[] {
  const topics = new Set<string>(['紫微斗数', '命学哲理']);
  if (/健康|疾厄|疾病|身体/.test(question)) topics.add('紫微斗数');
  if (/风水|阳宅|阴宅/.test(question)) topics.add('堪舆');
  if (/面相|长相/.test(question)) topics.add('面相');
  if (/小人|朋友|合伙/.test(question)) topics.add('识人');
  return [...topics];
}

function collectClassics(queries: string[]): SearchHit[] {
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const query of queries) {
    if (!query || query.length < 2) continue;
    for (const hit of searchClassics(query, 3)) {
      if (seen.has(hit.paragraphId)) continue;
      seen.add(hit.paragraphId);
      hits.push(hit);
      if (hits.length >= MAX_CLASSICS_HITS) return hits;
    }
  }
  return hits;
}

export interface InterpretGroundingInput {
  chart: ZiweiChart;
  question: string;
  /** 用户点选的宫位名，如「夫妻宫」 */
  focusPalace?: string;
  /** 用户点选的飞化星名 */
  focusStar?: string;
}

/** 组装命盘解读用的参考资料块 */
export function buildInterpretGrounding(input: InterpretGroundingInput): string {
  const { chart, question } = input;
  const ming = palaceByName(chart, '命宫');
  const focus = input.focusPalace
    ? palaceByName(chart, input.focusPalace.replace(/宫$/, ''))
    : undefined;

  const starNames = new Set<string>();
  for (const star of majorStarsIn(ming)) starNames.add(star.name);
  for (const name of ['财帛宫', '官禄宫', '迁移宫']) {
    for (const star of majorStarsIn(palaceByName(chart, name))) starNames.add(star.name);
  }
  if (focus) for (const star of majorStarsIn(focus)) starNames.add(star.name);
  if (input.focusStar) starNames.add(input.focusStar);

  const blocks: string[] = [];
  const keywords = questionKeywords(question);

  const starLines = [...starNames]
    .map((name) => starDescriptionText(name))
    .filter(Boolean)
    .slice(0, 8);
  if (starLines.length > 0) blocks.push(`【主星释义】\n${starLines.join('\n')}`);

  if (focus) {
    const stars = majorStarsIn(focus).map((s) => s.name);
    blocks.push(
      `【用户关注宫位】\n${palaceTitle(focus.name)}（${stars.length > 0 ? stars.join('、') : '空宫借对宫'}）`
      + `，宫干自化：${focus.selfSihua?.map((s) => `${s.starName}化${s.siHua}`).join('、') || '无'}`,
    );
  }

  const queries = [
    ...starNames,
    ...(focus ? [focus.name.replace(/宫$/, '')] : []),
    ...keywords,
  ];
  const classics = collectClassics(queries);
  if (classics.length > 0) {
    blocks.push(`【古籍原文】\n${classics
      .map((h) => `· 《${h.bookTitle}》${h.chapterTitle}：「${trim(h.text, PARAGRAPH_LIMIT)}」`)
      .join('\n')}`);
  }

  const topics = new Set(quoteTopicsFor(question));
  const quotes = TIANJI_QUOTES
    .filter((q) => topics.has(q.topic)
      || [...starNames].some((name) => q.text.includes(name))
      || keywords.some((k) => q.text.includes(k)))
    .slice(0, MAX_QUOTES);
  if (quotes.length > 0) {
    blocks.push(`【倪师语录】\n${quotes.map((q) => `· 「${q.text}」`).join('\n')}`);
  }

  const ziweiModule = TIANJI_MODULES.find((m) => m.id === 'tj-ziwei');
  if (ziweiModule) {
    blocks.push(
      `【倪师紫微体系要点】\n${ziweiModule.details.map((d) => `· ${d}`).join('\n')}`,
    );
  }

  return blocks.join('\n\n');
}

/** 合盘专用资料：夫妻宫断语 + 四化 + 桃花星 + 评分口径 */
export function buildHemingGrounding(chartA: ZiweiChart, chartB: ZiweiChart): string {
  const blocks: string[] = [];
  const sides = [
    { label: '甲方', chart: chartA },
    { label: '乙方', chart: chartB },
  ];

  const fqLines: string[] = [];
  const siHuaLines: string[] = [];
  const marriageStarLines: string[] = [];

  for (const { label, chart } of sides) {
    const fq = palaceByName(chart, '夫妻宫');
    const fuDe = palaceByName(chart, '福德宫');
    const fqStars = majorStarsIn(fq).map((s) => s.name);
    const fuDeStars = majorStarsIn(fuDe).map((s) => s.name);

    fqLines.push(
      `· ${label}夫妻宫：${fqStars.length > 0 ? fqStars.join('、') : '空宫'}`
      + `｜福德宫：${fuDeStars.length > 0 ? fuDeStars.join('、') : '空宫'}`,
    );

    for (const name of fqStars) {
      const knowledge = STAR_IN_FUQI_GU[name];
      if (!knowledge) continue;
      fqLines.push(
        `  - ${name}在夫妻宫：${knowledge.summary}；吉象：${knowledge.good}；`
        + `凶象：${knowledge.bad}；配偶特质：${knowledge.spouse_traits}；婚期：${knowledge.timing}`
        + (knowledge.ni_quote ? `；倪师：「${knowledge.ni_quote}」` : ''),
      );
    }

    for (const star of fq?.stars ?? []) {
      if (!star.siHua) continue;
      const rule = SIHUA_IN_FUQI_GU[`化${star.siHua}`];
      if (rule) siHuaLines.push(`· ${label}夫妻宫${star.name}化${star.siHua}：${rule}`);
    }
    siHuaLines.push(`· ${label}生年四化：${natalSiHuaText(chart)}`);

    const candidates = new Set<string>([
      ...(fq?.stars ?? []).map((s) => s.name),
      ...(fuDe?.stars ?? []).map((s) => s.name),
      ...(palaceByName(chart, '命宫')?.stars ?? []).map((s) => s.name),
    ]);
    for (const name of candidates) {
      const brief = MARRIAGE_STARS_BRIEF[name];
      if (brief) marriageStarLines.push(`· ${name}：${brief}`);
    }
  }

  if (fqLines.length > 0) blocks.push(`【夫妻宫与福德宫】\n${fqLines.join('\n')}`);
  if (siHuaLines.length > 0) blocks.push(`【夫妻宫四化】\n${siHuaLines.join('\n')}`);
  if (marriageStarLines.length > 0) {
    blocks.push(`【桃花与孤克星】\n${[...new Set(marriageStarLines)].join('\n')}`);
  }

  return blocks.join('\n\n');
}
