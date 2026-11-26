import React, { useEffect } from 'react'
import type { Pipeline } from '../domain/types'

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width
}: {
  open: boolean
  title: React.ReactNode
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
}) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px,96vw)` } : undefined}>
        <div className="modal-head">
          <h3>{title}</h3>
          <div className="spacer" />
          <button className="btn sm" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function PipelineSelect({
  pipelines,
  value,
  onChange,
  includeAll,
  allLabel
}: {
  pipelines: Pipeline[]
  value: string
  onChange: (id: string) => void
  includeAll?: boolean
  allLabel?: string
}) {
  return (
    <select className="select" style={{ width: 'auto', minWidth: 220 }} value={value} onChange={(e) => onChange(e.target.value)}>
      {includeAll && <option value="">{allLabel ?? '全部管线'}</option>}
      {pipelines.map((p) => (
        <option key={p.id} value={p.id}>
          {p.code} · {p.block} · DN{p.dn}
        </option>
      ))}
    </select>
  )
}

export function StatusBadge({ status }: { status: 'no_data' | 'ok' | 'below_tmin' | 'near_end' }) {
  if (status === 'below_tmin') return <span className="badge danger">低于最小壁厚</span>
  if (status === 'near_end') return <span className="badge warn">寿命不足两周期</span>
  if (status === 'ok') return <span className="badge ok">受控</span>
  return <span className="badge gray">无数据</span>
}

export function Pager({ page, pageCount, setPage, total }: { page: number; pageCount: number; setPage: (n: number) => void; total: number }) {
  return (
    <div className="pager">
      <span>共 {total} 行</span>
      <button className="btn sm" disabled={page <= 0} onClick={() => setPage(0)}>
        首页
      </button>
      <button className="btn sm" disabled={page <= 0} onClick={() => setPage(page - 1)}>
        上一页
      </button>
      <span>
        {page + 1} / {Math.max(1, pageCount)}
      </span>
      <button className="btn sm" disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}>
        下一页
      </button>
    </div>
  )
}

export function usePageRows<T>(rows: T[], page: number, size: number) {
  const pageCount = Math.max(1, Math.ceil(rows.length / size))
  const safe = Math.min(page, pageCount - 1)
  return { slice: rows.slice(safe * size, safe * size + size), pageCount, safe }
}
