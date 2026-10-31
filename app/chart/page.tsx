'use client';
import { useEffect, useRef, useState } from 'react';
import BirthForm from '@/components/BirthForm';
import ChartBoard from '@/components/ChartBoard';
import InsightPanel, { type Message } from '@/components/InsightPanel';
import CaseHistoryBar from '@/components/CaseHistoryBar';
import { generateChart } from '@/lib/ziwei/algorithm';
import { formToBirthInfo } from '@/lib/ziwei/share';
import { saveCase, formatCaseLabel, type SavedCaseForm } from '@/lib/case-history';
import {
  chartSessionId,
  loadChartSessions,
  patchChartSession,
  removeChartSession,
  saveChartSession,
  type ChartSession,
  type StoredMessage,
} from '@/lib/sessions';
import type { BirthInfo, ZiweiChart, Palace } from '@/lib/ziwei/types';

/**
 * 命盘页
 *
 * · 排盘 + 本命/大限/流年切换 + 点击十二宫看三方四正
 * · AI 流式解读
 * · 每次排盘连同对话一起存本地：重开页面能从历史里恢复命盘和聊天记录，不用重新花钱解读
 */

const SAVE_DEBOUNCE_MS = 700;

export default function ChartPage() {
  const [chart, setChart] = useState<ZiweiChart | null>(null);
  const [selectedPalace, setSelectedPalace] = useState<Palace | null>(null);

  // 表单与历史
  const [sessions, setSessions] = useState<ChartSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [preset, setPreset] = useState<SavedCaseForm | null>(null);
  const [presetKey, setPresetKey] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const lastFormRef = useRef<SavedCaseForm | null>(null);

  // 当前会话的对话（恢复历史时作为 InsightPanel 的初始值）
  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [panelKey, setPanelKey] = useState(0);
  const activeIdRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMessagesRef = useRef<StoredMessage[] | null>(null);

  useEffect(() => {
    setSessions(loadChartSessions());
  }, []);

  // 卸载/刷新前把待写入的对话落盘
  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const pending = pendingMessagesRef.current;
    const id = activeIdRef.current;
    if (pending && id) patchChartSession(id, { messages: pending });
  }, []);

  /** 对话变化 → 防抖落盘（流式输出时每秒几十次更新，不能每次都写） */
  const handleMessagesChange = (messages: Message[]) => {
    const id = activeIdRef.current;
    if (!id) return;
    pendingMessagesRef.current = messages.map((m) => ({
      role: m.role,
      content: m.content,
      hidden: m.hidden,
    }));
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const pending = pendingMessagesRef.current;
      if (!pending) return;
      setSessions(patchChartSession(id, { messages: pending }));
      pendingMessagesRef.current = null;
    }, SAVE_DEBOUNCE_MS);
  };

  /** 把防抖队列里还没写的对话立刻落盘（切换会话/卸载前调用） */
  const flushPending = () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingMessagesRef.current;
    const id = activeIdRef.current;
    pendingMessagesRef.current = null;
    if (pending && id) setSessions(patchChartSession(id, { messages: pending }));
  };

  /** 进入某个会话：命盘 + 对话一起恢复 */
  const openSession = (session: ChartSession) => {
    flushPending();
    let nextChart = session.chart;
    if (!nextChart) {
      try {
        nextChart = generateChart(formToBirthInfo(session.form));
      } catch {
        nextChart = null;
      }
    }
    if (!nextChart) {
      setHint('这条历史记录恢复失败：出生信息不完整。');
      return;
    }
    setChart(nextChart);
    setSelectedPalace(null);
    setHint(null);
    setPreset(session.form);
    setPresetKey((k) => k + 1);
    setInitialMessages(session.messages as Message[]);
    setPanelKey((k) => k + 1);
    activeIdRef.current = session.id;
    setActiveId(session.id);
    // 老数据没有命盘快照，补存一份
    if (!session.chart) {
      setSessions(saveChartSession({ form: session.form, chart: nextChart, messages: session.messages }));
    }
  };

  // ── 未起盘：出生信息表单 + 历史 ──
  if (!chart) {
    const items = sessions.map((s) => ({
      id: s.id,
      label: formatCaseLabel({ id: s.id, form: s.form, savedAt: s.updatedAt }),
      meta: s.messages.length > 0 ? `${s.messages.length} 条对话` : '',
    }));

    return (
      <main style={{ maxWidth: 760, margin: '0 auto', padding: '48px 20px' }}>
        <h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: 10, letterSpacing: '0.02em' }}>
          紫微斗数排盘
        </h1>
        <p style={{ color: 'var(--tx-3)', marginBottom: 28, fontSize: 15, lineHeight: 1.8 }}>
          输入出生年月日时，排盘引擎即时生成命盘，右侧可让 AI 逐宫解读。
          <br />
          <span style={{ fontSize: 13 }}>
            命盘与对话会存在本机：下次点历史记录就能接着聊，不用重新生成。
          </span>
        </p>

        <CaseHistoryBar
          title="最近的排盘（含对话）"
          items={items}
          activeId={activeId}
          onPick={(item) => {
            const target = sessions.find((s) => s.id === item.id);
            if (target) openSession(target);
          }}
          onRemove={(id) => {
            setSessions(removeChartSession(id));
            if (activeIdRef.current === id) {
              activeIdRef.current = null;
              setActiveId(null);
            }
          }}
        />

        {hint && (
          <div style={{ marginBottom: 16, fontSize: 13, color: '#dc2626' }}>{hint}</div>
        )}

        <BirthForm
          key={presetKey}
          initialData={preset ?? undefined}
          onFormSave={(form) => { lastFormRef.current = form; }}
          onSubmit={(info: BirthInfo) => {
            const next = generateChart(info);
            setChart(next);
            setSelectedPalace(null);
            setHint(null);

            const form = lastFormRef.current;
            if (!form) return;
            const id = chartSessionId(form);
            const existing = sessions.find((s) => s.id === id);
            // 同一个人再次排盘：接着上次的对话，而不是把记录清空
            const messages = existing?.messages ?? [];
            setSessions(saveChartSession({ form, chart: next, messages }));
            saveCase(form); // 同时进「人物」库，供合盘页快速选择
            setInitialMessages(messages as Message[]);
            setPanelKey((k) => k + 1);
            activeIdRef.current = id;
            setActiveId(id);
          }}
        />
      </main>
    );
  }

  // ── 已起盘 ──
  const activeSession = sessions.find((s) => s.id === activeId);
  const activeMessageCount = activeSession?.messages.length ?? 0;

  return (
    <main style={{ maxWidth: 1340, margin: '0 auto', padding: '24px 20px 56px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => {
            setChart(null);
            setSelectedPalace(null);
            setHint(null);
            setSessions(loadChartSessions());
          }}
          style={{
            padding: '8px 16px', cursor: 'pointer', fontSize: 14,
            border: '1px solid var(--bdr-med)', borderRadius: 8,
            background: 'var(--t-card)', color: 'var(--tx-1)',
          }}
        >
          ← 重新起盘
        </button>

        {sessions.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              const target = sessions.find((s) => s.id === e.target.value);
              if (target) openSession(target);
            }}
            aria-label="切换到历史排盘"
            style={{
              padding: '8px 12px', fontSize: 14, maxWidth: 360,
              border: '1px solid var(--bdr-med)', borderRadius: 8,
              background: 'var(--t-card)', color: 'var(--tx-1)', cursor: 'pointer',
            }}
          >
            <option value="">历史排盘（{sessions.length}）</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {formatCaseLabel({ id: s.id, form: s.form, savedAt: s.updatedAt })}
                {s.messages.length > 0 ? ` · ${s.messages.length} 条对话` : ''}
              </option>
            ))}
          </select>
        )}

        <span style={{ fontSize: 13, color: 'var(--tx-3)' }}>
          点击任意宫位可看它的三方四正，并让 AI 重点讲这一宫
          {activeMessageCount > 0 ? `　·　已保存 ${activeMessageCount} 条对话` : ''}
        </span>
      </div>

      <div className="chart-layout">
        <ChartBoard chart={chart} onPalaceSelect={setSelectedPalace} />
        <InsightPanel
          key={panelKey}
          chart={chart}
          selectedPalace={selectedPalace}
          initialMessages={initialMessages}
          autoGenerate={initialMessages.length === 0}
          onMessagesChange={handleMessagesChange}
        />
      </div>
    </main>
  );
}
