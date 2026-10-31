/**
 * lib/ai/prompts —— 系统提示词与消息组装
 *
 * 两条铁律：
 *   1. 排盘结论只来自引擎序列化后的文本，模型不得自己安星、不得虚构星曜。
 *   2. 输出必须能被前端 AiContent 渲染 —— 段落标题写成 **【标题】** 且独占一行。
 */

import 'server-only';
import type { ZiweiChart } from '@/lib/ziwei/types';
import { HEMING_METHODOLOGY, HEMING_SCORE_CRITERIA } from '@/lib/ziwei/heming-knowledge';
import { renderChartBrief, renderChartForPrompt, renderLiunianTable } from './chart-text';
import { buildHemingGrounding, buildInterpretGrounding } from './grounding';
import type { ChatMessage } from './stream';

const FORMAT_RULES = `
【输出格式（硬性要求，违反则前端无法渲染）】
1. 每个段落标题单独占一行，写成 \`**【标题】**\` 的形式，例如：**【命格定性】**。不要在标题行加其他文字。
2. 正文用自然的中文段落，不要使用 Markdown 表格、代码块、# 号标题、\`-\` 或 \`*\` 列表符号、也不要使用分隔线。
3. 正文里可以用 \`**加粗**\` 强调结论句，但不要整段加粗。
4. 不要输出「好的」「以下是」「希望对你有帮助」这类客套话，也不要复述命盘的原始字段清单。
5. 用户消息里如果已经给出了小标题结构，必须严格按它的小标题、顺序、数量输出，不增不减不改名。
6. 用户消息没有给结构时，自行用 3 到 4 个 \`**【小标题】**\` 组织，总长 400 到 700 字。
7. 最后单独一行给出固定免责声明：以上依倪海厦三合派紫微斗数体系推断，仅供参考；健康问题请就医，重大决定请结合现实条件判断。
8. 如果本次用户消息只是对已有解读的追问（简短提问，没有给出 【小标题】 结构），
   就只回答这一问：200 到 500 字，用 1 到 2 个 【小标题】 即可；
   不要重复前面已经讲过的段落，也不要重新输出整套结构。
`.trim();

const ZHONGZHOU_RULES = `
【学派口径】
- 以倪海厦《天纪》三合派为准：命宫为本、三方四正为用，命宫主星定基本格局与性格，财帛/官禄/迁移定用武之地。
- 大限、流年四化按引擎给出的表格讲，可以用宫干四化与自化解释宫位之间的引动，但只作辅助，
  不要像飞星派那样把「飞来飞去」的术语堆满，也不要引入来因宫、天心正运等本盘没有的概念。
- 煞星（擎羊陀罗火星铃星地空地劫）要讲清「条件」：在什么宫位、有无吉星制化、庙旺还是落陷，
  不要看到煞星就下凶断。
`.trim();

const EVIDENCE_RULES = `
【事实纪律】
- 只能使用下面给出的命盘数据与参考资料。命盘里没有的星曜、宫位、四化，一律不许提。
- 引用古籍或倪师原话时，只能引用参考资料里出现的句子，并写出处（如「《紫微斗数全书》」或「倪师天纪语录」），
  不得自行编造原文，也不要把现代解释伪装成古文。
- 资料里没有对应条目时，直接按三合派通则论述，不要假装引用。
- 问「哪几年」「什么时候」时，只从【近十年流年】表里挑年份作答，不要用表外年份，也不要说「需要流年盘才能算」。
- 语气笃定但不下宿命式断言：用「倾向」「容易」「在……条件下」而不是「必定」「一定会死/离」。
- 健康部分只谈倾向与保养方向，不做西医诊断、不推荐具体药物。
`.trim();

/** 命盘解读的系统提示词 */
export function buildInterpretSystemPrompt(chart: ZiweiChart, question: string): string {
  const focusPalace = /【(.+?)】/.exec(question)?.[1];
  const grounding = buildInterpretGrounding({
    chart,
    question,
    focusPalace: focusPalace && focusPalace.endsWith('宫') ? focusPalace : undefined,
    focusStar: /【.*?([\u4e00-\u9fa5]{2,3})化[禄权科忌]】/.exec(question)?.[1],
  });

  return [
    '你是一位精研倪海厦《天纪》的紫微斗数命理师，用三合派体系为命主解读命盘。',
    ZHONGZHOU_RULES,
    FORMAT_RULES,
    EVIDENCE_RULES,
    '===== 命盘数据（由排盘引擎给出，可直接引用）=====',
    renderChartForPrompt(chart),
    '===== 参考资料（只能引用这里出现的内容）=====',
    grounding || '（本盘未检索到匹配的古籍片段，按三合派通则论述。）',
  ].join('\n\n');
}

/** 命盘解读的消息数组 */
export function buildInterpretMessages(opts: {
  chart: ZiweiChart;
  messages: ChatMessage[];
}): ChatMessage[] {
  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
  const system = buildInterpretSystemPrompt(opts.chart, lastUser?.content ?? '');
  return [{ role: 'system', content: system }, ...opts.messages];
}

/** 合盘分析的系统提示词 */
export function buildHemingSystemPrompt(chartA: ZiweiChart, chartB: ZiweiChart): string {
  const scoreTable = Object.entries(HEMING_SCORE_CRITERIA)
    .map(([level, text]) => `- ${level}：${text}`)
    .join('\n');

  return [
    '你是一位精研倪海厦《天纪》的紫微斗数命理师，正在为两位当事人做合盘分析。',
    ZHONGZHOU_RULES,
    FORMAT_RULES,
    EVIDENCE_RULES,
    '===== 合盘方法论 =====',
    HEMING_METHODOLOGY,
    '===== 星级评定口径 =====',
    scoreTable,
    '===== 甲方命盘 =====',
    renderChartBrief(chartA, '甲方'),
    '===== 乙方命盘 =====',
    renderChartBrief(chartB, '乙方'),
    '===== 近十年流年（双方共用干支，流年命宫分别对照）=====',
    renderLiunianTable(
      [{ label: '甲', chart: chartA }, { label: '乙', chart: chartB }],
      new Date().getFullYear(),
      10,
    ),
    '===== 合盘参考资料 =====',
    buildHemingGrounding(chartA, chartB) || '（未检索到夫妻宫专项断语，按方法论通则论述。）',
  ].join('\n\n');
}

/** 合盘分析的输出结构（用户消息） */
export const HEMING_USER_STRUCTURE = `请基于双方命盘做一次完整的合盘分析，严格按以下小标题输出，顺序不变：

**【合盘总评】**
给出星级（一星到五星，只取整数，不要半星）与一句话总评，说明这个匹配度的核心原因。

**【双方命格基础】**
两人命宫主星的性格底色，是互补还是同类，相处的基本张力在哪里。

**【夫妻宫互参】**
结合双方夫妻宫与福德宫的主星、四化、煞星，说明彼此的吸引点与消磨点。

**【四化互飞】**
双方生年四化落在对方命盘的影响，尤其化禄与化忌的方向。

**【大限同步】**
双方当前大限分别走什么运，是否同旺，近十年感情与合伙的关键节点。

**【相处建议】**
三到五条具体可执行的建议，不要空话。

**【风险提示】**
最需要警惕的两三个具体情形，以及可以怎样提前化解。`;

/** 合盘追问的指令：只要答案，不要重抄一遍结构 */
export const HEMING_FOLLOWUP_PREFIX = '请基于上面的完整分析回答这个问题，不要重新输出整篇结构，也不必重复免责声明';

/**
 * 合盘分析的消息数组
 *
 * 首次分析：system + 结构化的完整分析要求。
 * 后续追问：system + 结构 + 历史（含上一次完整分析）+ 本次问题，
 * 这样追问只产出一段定向回答，既省钱也不丢上下文。
 */
export function buildHemingMessages(opts: {
  chartA: ZiweiChart;
  chartB: ZiweiChart;
  question?: string;
  history?: ChatMessage[];
}): ChatMessage[] {
  const system = buildHemingSystemPrompt(opts.chartA, opts.chartB);
  const history = (opts.history ?? []).filter((m) => m.role !== 'system');

  if (history.length === 0) {
    const userContent = opts.question
      ? `${HEMING_USER_STRUCTURE}\n\n此外，请重点回答这个问题：${opts.question}`
      : HEMING_USER_STRUCTURE;
    return [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ];
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: HEMING_USER_STRUCTURE },
    ...history,
  ];
  if (opts.question) {
    messages.push({
      role: 'user',
      content: `${HEMING_FOLLOWUP_PREFIX}：${opts.question}`,
    });
  }
  return messages;
}
