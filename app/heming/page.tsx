'use client';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import BirthForm, { type BirthFormState } from '@/components/BirthForm';
import CaseHistoryBar from '@/components/CaseHistoryBar';
import {
  formatCaseLabel,
  loadCases,
  removeCase,
  saveCase,
  type SavedCase,
  type SavedCaseForm,
} from '@/lib/case-history';
import {
  loadHemingSessions,
  removeHemingSession,
  saveHemingSession,
  type HemingSession,
} from '@/lib/sessions';
import { formToBirthInfo } from '@/lib/ziwei/share';
import { generateChart as buildChart } from '@/lib/ziwei/algorithm';
import { streamAiResponse } from '@/lib/ai/client';
import type { BirthInfo, ZiweiChart } from '@/lib/ziwei/types';
import { useTheme } from '@/components/ThemeProvider';

// ─── AiContent 渲染器（与 InsightPanel 一致）────────────────
function AiContent({ text, streaming }: { text: string; streaming?: boolean }) {
  const lines = text.split('\n');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {lines.map((line, i) => {
        const sectionMatch = line.match(/^\*\*【(.+?)】\*\*$/);
        if (sectionMatch) {
          return (
            <div key={i} style={{ paddingTop: i === 0 ? 0 : '14px', paddingBottom: '4px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ac)', letterSpacing: '0.04em' }}>
                【{sectionMatch[1]}】
              </span>
            </div>
          );
        }
        if (line.trim() === '') return <div key={i} style={{ height: '4px' }} />;
        const parts = line.split(/\*\*(.+?)\*\*/);
        return (
          <div key={i} style={{ fontSize: '13px', lineHeight: 1.75, color: 'var(--tx-2)' }}>
            {parts.map((part, j) =>
              j % 2 === 0
                ? part
                : <strong key={j} style={{ fontWeight: 500, color: 'var(--tx-0)' }}>{part}</strong>
            )}
          </div>
        );
      })}
      {streaming && (
        <span style={{
          display: 'inline-block', width: '7px', height: '13px',
          background: 'var(--ac)', opacity: 0.5, borderRadius: '2px',
          animation: 'pulse 1s ease-in-out infinite',
          verticalAlign: 'middle', marginLeft: '2px',
        }} />
      )}
    </div>
  );
}

export default function HemingPage() {
  const router = useRouter();
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  // ─── 双方命盘状态 ─────────────────────────────────────────
  const [chartA, setChartA] = useState<ZiweiChart | null>(null);
  const [chartB, setChartB] = useState<ZiweiChart | null>(null);
  // 双方表单状态由 BirthForm onFormSave 同步到此处，统一按钮触发起盘
  const [formA, setFormA] = useState<BirthFormState | null>(null);
  const [formB, setFormB] = useState<BirthFormState | null>(null);

  // 历史出生信息：同一个例子不用每次重填
  const [cases, setCases] = useState<SavedCase[]>([]);
  const [presetA, setPresetA] = useState<SavedCaseForm | null>(null);
  const [presetB, setPresetB] = useState<SavedCaseForm | null>(null);
  const [presetKeyA, setPresetKeyA] = useState(0);
  const [presetKeyB, setPresetKeyB] = useState(0);
  // 合盘会话：两位当事人 + 完整分析 + 追问，存本地可恢复
  const [sessions, setSessions] = useState<HemingSession[]>([]);

  // ─── AI 合盘分析状态 ─────────────────────────────────────
  // analysis = 首次完整合盘；thread = 后续追问，一问一段，不再重跑整篇
  const [analysis, setAnalysis] = useState('');
  const [thread, setThread] = useState<{ question: string; answer: string }[]>([]);
  const [history, setHistory] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [streamTarget, setStreamTarget] = useState<'main' | 'followup' | null>(null);
  const [question, setQuestion] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const analysisRef = useRef<HTMLDivElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const analyzingRef = useRef(false);

  // ─── 起盘（单次调用，返回 chart 给统一流程使用）──────────
  // 开源版不含后端 /api/generate：直接用本仓库的排盘引擎在浏览器里起盘
  const generateChart = useCallback(async (info: BirthInfo): Promise<ZiweiChart | null> => {
    try {
      return buildChart(info);
    } catch {
      return null;
    }
  }, []);

  // 表单是否填齐
  const isFormReady = (f: BirthFormState | null): boolean =>
    !!(f && f.year && f.month && f.day && f.gender && (f.unknownTime || (f.clockHour !== '' && f.clockMinute !== '')));

  useEffect(() => {
    setCases(loadCases());
    setSessions(loadHemingSessions());
  }, []);

  /** 从历史里选一个人填进甲方/乙方，并清掉上一个组合的分析结果 */
  const pickFromHistory = (side: 'a' | 'b', form: SavedCaseForm) => {
    if (side === 'a') {
      setPresetA(form);
      setPresetKeyA(k => k + 1);
      setFormA(form);
      setChartA(null);
    } else {
      setPresetB(form);
      setPresetKeyB(k => k + 1);
      setFormB(form);
      setChartB(null);
    }
    setAnalysis('');
    setThread([]);
    setHistory([]);
    setErrorMessage(null);
    setFormError(null);
  };

  /** 恢复一场合盘：双方信息 + 完整分析 + 追问记录 */
  const openHemingSession = (session: HemingSession) => {
    setPresetA(session.formA);
    setPresetKeyA(k => k + 1);
    setFormA(session.formA);
    setPresetB(session.formB);
    setPresetKeyB(k => k + 1);
    setFormB(session.formB);
    setChartA(null);
    setChartB(null);
    setAnalysis(session.analysis);
    setThread(session.thread);

    // 追问要带上下文：上次完整分析 + 每轮问答
    const rebuilt: { role: 'user' | 'assistant'; content: string }[] = [];
    if (session.analysis) rebuilt.push({ role: 'assistant', content: session.analysis });
    for (const item of session.thread) {
      rebuilt.push({ role: 'user', content: item.question });
      rebuilt.push({ role: 'assistant', content: item.answer });
    }
    setHistory(rebuilt);
    setErrorMessage(null);
    setFormError(null);
    setTimeout(() => analysisRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  };

  // ─── 统一入口：起盘 + 合盘分析 ─────────────────────────────
  const runAnalysis = useCallback(async (q?: string) => {
    setFormError(null);
    if (!isFormReady(formA) || !isFormReady(formB)) {
      setFormError('请先填写双方完整出生信息');
      return;
    }
    if (analyzingRef.current) return;

    const trimmed = q?.trim() ?? '';
    // 已有完整分析 + 带问题 → 走追问：只带历史、只问这一题，不再重跑整篇
    const isFollowUp = Boolean(trimmed) && analysis.length > 0;

    // 记住这次用到的两个人，下次直接选
    if (!isFollowUp && formA) setCases(saveCase(formA));
    if (!isFollowUp && formB) setCases(saveCase(formB));

    analyzingRef.current = true;
    setAnalyzing(true);
    setStreamTarget(isFollowUp ? 'followup' : 'main');
    setErrorMessage(null);

    if (isFollowUp) {
      setThread(prev => [...prev, { question: trimmed, answer: '' }]);
    } else {
      setAnalysis('');
      setThread([]);
      setHistory([]);
    }

    try {
      // 并行起两张盘（如果还没起）
      let cA = chartA;
      let cB = chartB;
      const [newA, newB] = await Promise.all([
        cA ? Promise.resolve(cA) : generateChart(formToBirthInfo(formA!)),
        cB ? Promise.resolve(cB) : generateChart(formToBirthInfo(formB!)),
      ]);
      cA = newA;
      cB = newB;
      if (!cA || !cB) {
        setErrorMessage('命盘生成失败，请检查双方的出生信息是否完整。');
        if (isFollowUp) setThread(prev => prev.slice(0, -1));
        setAnalyzing(false);
        analyzingRef.current = false;
        return;
      }
      if (!chartA) setChartA(cA);
      if (!chartB) setChartB(cB);

      const res = await fetch('/api/heming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isFollowUp
            ? { chartA: cA, chartB: cB, question: trimmed, history }
            : { chartA: cA, chartB: cB },
        ),
      });
      if (res.status === 404) throw new Error('api-missing');

      let text = '';
      await streamAiResponse(res, (delta) => {
        text += delta;
        if (isFollowUp) {
          // 追加到最后一条追问里，保持上面的完整分析不动
          setThread(prev => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (!last) return prev;
            copy[copy.length - 1] = { ...last, answer: last.answer + delta };
            return copy;
          });
        } else {
          setAnalysis(text);
        }
      });

      if (isFollowUp) {
        setHistory(prev => [...prev, { role: 'user', content: trimmed }, { role: 'assistant', content: text }]);
        setQuestion('');
      } else {
        setHistory([{ role: 'assistant', content: text }]);
      }

      // 存一场合盘会话：两位当事人 + 完整分析 + 追问，下次直接恢复
      if (formA && formB) {
        const nextThread = isFollowUp ? [...thread, { question: trimmed, answer: text }] : [];
        setSessions(saveHemingSession({
          formA,
          formB,
          analysis: isFollowUp ? analysis : text,
          thread: nextThread,
        }));
      }

      // scroll to analysis
      setTimeout(() => (threadEndRef.current ?? analysisRef.current)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    } catch (e) {
      if (isFollowUp) setThread(prev => prev.slice(0, -1));
      if (e instanceof Error && e.message === 'api-missing') {
        setErrorMessage('开源版不含合盘 AI 分析接口（/api/heming），需要你自己实现后才能用。两人的命盘可以分别到「排盘」页（/chart）查看。');
      } else {
        setErrorMessage(e instanceof Error && e.message ? e.message : '分析暂时不可用，请重试。');
      }
    } finally {
      analyzingRef.current = false;
      setAnalyzing(false);
      setStreamTarget(null);
    }
  }, [analysis, chartA, chartB, formA, formB, generateChart, history, thread]);

  const cardStyle = {
    background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.9)',
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(200,160,60,0.2)'}`,
    borderRadius: '16px',
    padding: '24px',
  };

  const labelStyle = {
    fontSize: '10px', letterSpacing: '0.4em', color: 'var(--ac)', opacity: 0.7,
    marginBottom: '16px', display: 'block',
  };

  const caseItems = cases.map((c) => ({ id: c.id, label: formatCaseLabel(c) }));

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-0)' }}>
      {/* 顶栏 */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 50,
        background: isDark ? 'rgba(2,8,16,0.88)' : 'rgba(250,245,235,0.92)',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        borderBottom: '1px solid var(--bdr)',
        display: 'flex', alignItems: 'center', padding: '0 24px', height: '52px', gap: '16px',
      }}>
        <button
          onClick={() => router.push('/')}
          style={{
            display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px',
            color: 'var(--tx-3)', background: 'none', border: 'none', cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: '16px' }}>‹</span>
          <span>返回</span>
        </button>
        <div style={{ width: '1px', height: '20px', background: 'var(--bdr-med)' }} />
        <span style={{ fontSize: '13px', color: 'var(--ac)', letterSpacing: '0.2em' }}>合盘分析</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: '11px', color: 'var(--tx-3)' }}>感情 · 合伙 · 亲子 · 朋友</span>
      </header>

      {/* 主体 */}
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '32px 24px 80px' }}>

        {/* 标题 */}
        <div style={{ textAlign: 'center', marginBottom: '36px' }}>
          <div style={{ fontSize: '28px', color: 'var(--ac)', opacity: 0.15, marginBottom: '12px' }}>☯</div>
          <h1 style={{ fontSize: '22px', fontWeight: 600, letterSpacing: '0.15em', color: 'var(--tx-0)', marginBottom: '8px' }}>
            紫微合盘
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--tx-3)', lineHeight: 1.6 }}>
            输入两个人的出生信息，AI 基于倪海厦体系分析双方命盘的缘分匹配度、感情走向与相处建议
          </p>
        </div>

        {/* 最近的合盘会话（含分析与追问） */}
        <CaseHistoryBar
          title="最近的合盘（含对话）"
          items={sessions.map((s) => ({
            id: s.id,
            label: `${s.formA.name?.trim() || '甲方'} × ${s.formB.name?.trim() || '乙方'}`,
            meta: `${s.formA.year}-${s.formB.year}${s.thread.length > 0 ? ` · ${s.thread.length} 条追问` : ' · 完整分析'}`,
          }))}
          onPick={(item) => {
            const target = sessions.find((s) => s.id === item.id);
            if (target) openHemingSession(target);
          }}
          onRemove={(id) => setSessions(removeHemingSession(id))}
        />

        {/* 双栏表单 */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '24px' }}
          className="heming-grid">
          {/* 甲方 */}
          <div style={cardStyle}>
            <span style={labelStyle}>甲方 — A</span>
            <CaseHistoryBar
              title="从历史选择"
              limit={4}
              items={caseItems}
              onPick={(item) => {
                const record = cases.find((c) => c.id === item.id);
                if (record) pickFromHistory('a', record.form);
              }}
              onRemove={(id) => setCases(removeCase(id))}
            />
            <BirthForm
              key={`a-${presetKeyA}`}
              hideSubmit
              initialData={presetA ?? undefined}
              onSubmit={() => {}}
              onFormSave={setFormA}
            />
          </div>

          {/* 乙方 */}
          <div style={cardStyle}>
            <span style={labelStyle}>乙方 — B</span>
            <CaseHistoryBar
              title="从历史选择"
              limit={4}
              items={caseItems}
              onPick={(item) => {
                const record = cases.find((c) => c.id === item.id);
                if (record) pickFromHistory('b', record.form);
              }}
              onRemove={(id) => setCases(removeCase(id))}
            />
            <BirthForm
              key={`b-${presetKeyB}`}
              hideSubmit
              initialData={presetB ?? undefined}
              onSubmit={() => {}}
              onFormSave={setFormB}
            />
          </div>
        </div>

        {/* ═══ 大合盘分析框（视觉中心，始终显示）════════════════ */}
        <div ref={analysisRef} style={{
          ...cardStyle,
          minHeight: '320px',
          padding: '32px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: (!analysis && !analyzing) ? 'center' : 'flex-start',
        }}>
          {/* 区块标题 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: (analysis || analyzing) ? '20px' : '24px' }}>
            <span style={{ color: 'var(--ac)', opacity: 0.6 }}>◉</span>
            <span style={{ fontSize: '11px', letterSpacing: '0.3em', color: 'var(--tx-3)' }}>合盘分析 · HEMING</span>
          </div>

          {/* 状态分支 */}
          {!analysis && !analyzing && (
            <div style={{ textAlign: 'center', padding: '32px 0' }}>
              <div style={{ fontSize: '13px', color: 'var(--tx-3)', marginBottom: '24px', lineHeight: 1.7 }}>
                填好双方出生信息后，点击下方按钮<br />
                AI 将基于倪海厦体系深度分析两人缘分匹配度
              </div>
              <button
                onClick={() => runAnalysis()}
                style={{
                  padding: '14px 40px', borderRadius: 'var(--r-pill)', border: 'none',
                  background: 'linear-gradient(135deg, #9a6210, #c88020)',
                  color: '#fff8e8', fontSize: '14px', fontWeight: 600,
                  letterSpacing: '0.15em', cursor: 'pointer',
                  boxShadow: '0 4px 16px rgba(140,100,20,0.25)',
                  transition: 'transform 0.15s',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; }}
              >
                开始合盘分析
              </button>
              {formError && (
                <div style={{ marginTop: '20px', fontSize: '13px', color: '#dc2626' }}>
                  {formError}
                </div>
              )}
            </div>
          )}

          {analyzing && !analysis && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '40px 0', color: 'var(--tx-3)', fontSize: '13px' }}>
              <div style={{
                width: '14px', height: '14px',
                border: '2px solid var(--bdr-med)', borderTopColor: 'var(--ac)',
                borderRadius: '50%', animation: 'spin 0.8s linear infinite',
              }} />
              正在对比双方命盘…
            </div>
          )}

          {analysis && <AiContent text={analysis} streaming={analyzing && streamTarget === 'main'} />}

          {/* 追问：一问一段，追加在完整分析之后，不覆盖 */}
          {thread.map((item, i) => (
            <div
              key={`${i}-${item.question}`}
              ref={i === thread.length - 1 ? threadEndRef : undefined}
              style={{ marginTop: '18px', paddingTop: '16px', borderTop: '1px solid var(--bdr)' }}
            >
              <div style={{
                fontSize: '12px', fontWeight: 500, color: 'var(--ac)',
                marginBottom: '10px', lineHeight: 1.6,
              }}>
                {item.question}
              </div>
              <AiContent
                text={item.answer}
                streaming={analyzing && streamTarget === 'followup' && i === thread.length - 1}
              />
            </div>
          ))}

          {errorMessage && (
            <div style={{ padding: '12px 16px', borderRadius: '10px', border: '1px solid var(--bdr)', background: 'var(--bg-card)', fontSize: '13px', color: 'var(--tx-2)', marginTop: '12px' }}>
              {errorMessage}
            </div>
          )}
        </div>

        {/* ═══ 针对合盘的追问聊天框（仅分析完成后显示）═══════════ */}
        {analysis && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '16px' }}>
            <div style={{ fontSize: '12px', letterSpacing: '0.2em', color: 'var(--tx-3)', marginBottom: '4px' }}>
              针对此次合盘继续追问
            </div>

            {/* 快捷问题 */}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {[
                '感情匹配度如何？',
                '适合合伙创业吗？',
                '两人结婚是否合适？',
                '哪方面最容易产生矛盾？',
                '财运是否互补？',
              ].map(q => (
                <button
                  key={q}
                  onClick={() => { setQuestion(q); runAnalysis(q); }}
                  disabled={analyzing}
                  style={{
                    fontSize: '13px', padding: '7px 14px',
                    borderRadius: 'var(--r-pill)',
                    border: '1px solid var(--bdr-med)',
                    background: 'transparent', color: 'var(--tx-2)',
                    cursor: analyzing ? 'not-allowed' : 'pointer',
                    opacity: analyzing ? 0.5 : 1,
                    transition: 'border-color 0.15s',
                  }}
                  onMouseEnter={e => { if (!analyzing) (e.currentTarget as HTMLElement).style.borderColor = 'var(--ac-bdr)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--bdr-med)'; }}
                >
                  {q}
                </button>
              ))}
            </div>

            {/* 输入框 + 追问按钮 */}
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                value={question}
                onChange={e => setQuestion(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !analyzing && question.trim()) runAnalysis(question); }}
                placeholder="继续追问，如：哪几年是两人感情关键期？"
                disabled={analyzing}
                className="input-base"
                style={{ fontSize: '13px', flex: 1 }}
              />
              <button
                onClick={() => { if (question.trim()) runAnalysis(question); }}
                disabled={analyzing || !question.trim()}
                style={{
                  padding: '10px 20px', borderRadius: 'var(--r-sm)', border: 'none',
                  background: analyzing || !question.trim() ? 'var(--bg-2)' : 'var(--tx-0)',
                  color: analyzing || !question.trim() ? 'var(--tx-3)' : 'white',
                  fontSize: '13px', fontWeight: 500,
                  cursor: analyzing || !question.trim() ? 'not-allowed' : 'pointer',
                  transition: 'all 0.15s', whiteSpace: 'nowrap',
                }}
              >
                {analyzing ? '分析中…' : '继续追问'}
              </button>
            </div>
          </div>
        )}
      </div>

      <style>{`
        @media (max-width: 680px) {
          .heming-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}
