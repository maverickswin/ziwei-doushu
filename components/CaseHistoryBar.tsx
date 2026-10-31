'use client';
import type { ReactNode } from 'react';

export interface HistoryItem {
  id: string;
  label: string;
  /** 右侧小字，例如「6 条对话」 */
  meta?: string;
}

interface HistoryBarProps {
  items: HistoryItem[];
  onPick: (item: HistoryItem) => void;
  onRemove: (id: string) => void;
  /** 一行说明，例如「最近排过的盘」 */
  title?: string;
  /** 只显示最近 N 条（合盘双栏空间小） */
  limit?: number;
  /** 当前正在看的会话，高亮 */
  activeId?: string | null;
  /** 标题右侧额外内容（比如「清空」） */
  extra?: ReactNode;
}

/**
 * 历史会话条：点一下直接恢复命盘与对话，不用重排、不用重新解读。
 * 纯展示组件，读写 localStorage 由父级负责。
 */
export default function CaseHistoryBar({
  items,
  onPick,
  onRemove,
  title = '最近排过的盘',
  limit = 12,
  activeId = null,
  extra,
}: HistoryBarProps) {
  if (items.length === 0) return null;
  const shown = items.slice(0, limit);

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 8,
      }}>
        <span style={{ fontSize: 12, letterSpacing: '0.16em', color: 'var(--tx-3)' }}>
          {title}
        </span>
        {extra}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {shown.map((item) => {
          const active = item.id === activeId;
          return (
            <span
              key={item.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 8px 7px 12px',
                borderRadius: 999,
                border: `1px solid ${active ? 'var(--ac-bdr)' : 'var(--bdr-med)'}`,
                background: active ? 'var(--ac-bg)' : 'var(--bg-card)',
                fontSize: 13,
                color: active ? 'var(--ac-dim)' : 'var(--tx-2)',
                maxWidth: '100%',
              }}
            >
              <button
                type="button"
                onClick={() => onPick(item)}
                title="恢复这张盘和之前的对话"
                style={{
                  border: 'none',
                  background: 'transparent',
                  padding: 0,
                  fontSize: 13,
                  color: 'inherit',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {item.label}
              </button>
              {item.meta && (
                <span style={{
                  fontSize: 11,
                  color: 'var(--tx-3)',
                  whiteSpace: 'nowrap',
                }}>
                  {item.meta}
                </span>
              )}
              <button
                type="button"
                onClick={() => onRemove(item.id)}
                aria-label="删除这条记录"
                title="删除这条记录（含对话）"
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--tx-3)',
                  fontSize: 15,
                  lineHeight: 1,
                  padding: '0 4px',
                  cursor: 'pointer',
                }}
              >
                ×
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}
