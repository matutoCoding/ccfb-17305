import React, { useMemo, useState, useEffect } from 'react'
import { useData } from '../data/store'
import { useResolvedLines } from '../state/selectors'
import { buildPlan, type PlanItem } from '../domain/plan'
import { NOW } from '../domain/now'
import { Viewer3D } from '../components/Viewer3D'
import { isoDataURL } from '../viz/iso-drawing'
import { exportTaskCsv, exportTaskHtml, zoneLabel } from '../domain/task-sheet'
import { toast } from '../components/Toast'
import { useNav } from '../state/nav'

export default function PlanPage({ initialPipelineId }: { initialPipelineId?: string }) {
  const { points, readings, pipelines } = useData()
  const lines = useResolvedLines()
  const nav = useNav()
  const all = useMemo(() => buildPlan(lines, points, readings, NOW), [lines, points, readings])

  const [filterPl, setFilterPl] = useState(initialPipelineId ?? 'all')
  const [focusPl, setFocusPl] = useState(initialPipelineId ?? all[0]?.pipelineId ?? pipelines[0]?.id ?? '')
  const [activeSug, setActiveSug] = useState<string | undefined>()

  useEffect(() => {
    if (initialPipelineId) setFocusPl(initialPipelineId)
  }, [initialPipelineId])

  const shown = useMemo(() => (filterPl === 'all' ? all : all.filter((x) => x.pipelineId === filterPl)), [all, filterPl])
  const focusLine = lines.find((l) => l.pipeline.id === focusPl)
  const focusItems = useMemo(() => all.filter((x) => x.pipelineId === focusPl), [all, focusPl])

  useEffect(() => {
    const h = (e: Event) => setActiveSug((e as CustomEvent<string>).detail)
    window.addEventListener('plan-suggestion-click', h)
    return () => window.removeEventListener('plan-suggestion-click', h)
  }, [])

  const counts = {
    high: all.filter((a) => a.priority === 'high').length,
    mid: all.filter((a) => a.priority === 'medium').length,
    pipelines: new Set(all.map((a) => a.pipelineId)).size
  }

  const doExportHtml = () => {
    if (!focusLine) return
    const png = isoDataURL(focusLine, { suggestions: focusItems, width: 1500, height: 950 })
    exportTaskHtml(focusLine, focusItems, png)
    toast('任务单已生成：含等轴测加点截图与点位编号，可直接打印为 PDF')
  }

  return (
    <div>
      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="k">建议加点总数</div>
          <div className="v brand">{all.length}</div>
        </div>
        <div className="stat">
          <div className="k">高优先级</div>
          <div className="v danger">{counts.high}</div>
        </div>
        <div className="stat">
          <div className="k">中优先级</div>
          <div className="v warn">{counts.mid}</div>
        </div>
        <div className="stat">
          <div className="k">涉及管线</div>
          <div className="v ok">{counts.pipelines}</div>
        </div>
      </div>

      <div className="toolbar">
        <select className="select" style={{ width: 280 }} value={filterPl} onChange={(e) => setFilterPl(e.target.value)}>
          <option value="all">全部管线（{all.length} 条建议）</option>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code}（{all.filter((a) => a.pipelineId === p.id).length}）
            </option>
          ))}
        </select>
        <div className="spacer" />
        <button className="btn" disabled={!focusLine} onClick={() => exportTaskCsv(focusLine!, focusItems)}>
          ⬇ 导出当前管线 CSV 任务单
        </button>
        <button className="btn primary" disabled={!focusLine} onClick={doExportHtml}>
          🖨 导出/打印任务单（带等轴测截图）
        </button>
        <button className="btn" disabled={!focusLine} onClick={() => nav.go('viewer', { pipelineId: focusPl, showSuggestions: true })}>
          🧊 完整三维
        </button>
      </div>

      <div className="plan-layout">
        <div className="plan-side">
        {shown.length > 200 && (
          <div className="warn-box">结果较多，仅渲染前 200 条；可用上方管线筛选定位，完整内容见导出的任务单。</div>
        )}
        {shown.slice(0, 200).map((sg) => (
            <SugCard
              key={sg.id}
              sg={sg}
              active={activeSug === sg.id}
              onFocus={() => {
                setFocusPl(sg.pipelineId)
                setActiveSug(sg.id)
              }}
              onView3d={() => nav.go('viewer', { pipelineId: sg.pipelineId, fittingId: sg.fittingId, showSuggestions: true })}
            />
          ))}
          {shown.length === 0 && <div className="empty">当前筛选下没有需要新增的测点，覆盖与寿命状况良好。</div>}
        </div>

        <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12 }}>
          <div className="row" style={{ padding: '2px 6px' }}>
            <b className="mono">{focusLine?.pipeline.code}</b>
            <span className="muted small">{focusItems.length} 个建议点已落在三维对应钟点/轴向位置</span>
          </div>
          {focusLine ? (
            <div style={{ flex: 1, minHeight: 480 }}>
              <Viewer3D line={focusLine} mode="ratio" periodId="latest" opacity={0.95} suggestions={focusItems} showSuggestions />
            </div>
          ) : (
            <div className="empty">请选择管线</div>
          )}
        </div>
      </div>
    </div>
  )
}

function SugCard({ sg, active, onFocus, onView3d }: { sg: PlanItem; active: boolean; onFocus: () => void; onView3d: () => void }) {
  return (
    <div className={`sug-card ${sg.priority}`} style={active ? { outline: '2px solid var(--brand-2)' } : undefined} onClick={onFocus}>
      <div className="t">
        <span className={`badge ${sg.priority === 'high' ? 'danger' : sg.priority === 'medium' ? 'warn' : 'ok'}`}>
          {sg.priority === 'high' ? '高' : sg.priority === 'medium' ? '中' : '低'}
        </span>
        <span className="mono">{sg.pipelineCode}</span>
        <span className="muted small mono">{sg.fittingCode}</span>
        <div className="spacer" />
        <span className="badge purple">{zoneLabel(sg.zone)}</span>
      </div>
      <div className="d">{sg.reasonDetail}</div>
      <div className="row" style={{ marginTop: 8 }}>
        <span className="small muted">
          建议钟点 <b>{sg.clock.toFixed(1)}</b> · 轴向 <b>{Math.round(sg.axialDistanceMm)}mm</b>
          {sg.remainingLifeYears != null && isFinite(sg.remainingLifeYears) && <> · RL {sg.remainingLifeYears.toFixed(1)}y</>}
        </span>
        <div className="spacer" />
        <button
          className="btn sm"
          onClick={(e) => {
            e.stopPropagation()
            onView3d()
          }}
        >
          在三维定位
        </button>
      </div>
    </div>
  )
}
