import React, { useMemo, useRef, useState, useEffect } from 'react'
import { useData } from '../data/store'
import { useResolvedLine, useSuspiciousSet } from '../state/selectors'
import { PipelineSelect } from '../components/ui'
import { Viewer3D, type Viewer3DHandle, type ViewMode } from '../components/Viewer3D'
import { PointHistory } from '../components/PointHistory'
import { buildLinePlan } from '../domain/plan'
import { NOW } from '../domain/now'
import { useNav } from '../state/nav'

export default function ViewerPage({ params }: { params: ReturnType<typeof useNav>['params'] }) {
  const { pipelines, points, readings } = useData()
  const nav = useNav()
  const [pipelineId, setPipelineId] = useState(params.pipelineId ?? pipelines[0]?.id ?? '')
  useEffect(() => {
    if (params.pipelineId) setPipelineId(params.pipelineId)
  }, [params.pipelineId])
  const line = useResolvedLine(pipelineId)
  const sus = useSuspiciousSet()

  const [mode, setMode] = useState<ViewMode>(params.mode === 'long' || params.mode === 'short' || params.mode === 'diff' ? params.mode : 'ratio')
  const [periodId, setPeriodId] = useState<string>(params.periodId ?? 'latest')
  const [periodA, setPeriodA] = useState(params.periodA ?? 'per-2025')
  const [periodB, setPeriodB] = useState(params.periodB ?? 'per-2026')
  const [opacity, setOpacity] = useState(0.96)
  const [selectedPointId, setSelectedPointId] = useState<string | undefined>(params.pointId)
  const [showSug, setShowSug] = useState(!!params.showSuggestions)
  const [sectionOn, setSectionOn] = useState(false)
  const [sectionFitting, setSectionFitting] = useState(params.fittingId ?? '')
  const [sectionFrac, setSectionFrac] = useState(0.5)
  const viewerRef = useRef<Viewer3DHandle>(null)

  useEffect(() => {
    if (params.pointId) setSelectedPointId(params.pointId)
    if (params.fittingId) {
      setSectionFitting(params.fittingId)
    }
    if (params.showSuggestions) setShowSug(true)
  }, [params.pointId, params.fittingId, params.showSuggestions])

  const suggestions = useMemo(
    () => (line && showSug ? buildLinePlan(line, points, readings, NOW) : []),
    [line, showSug, points, readings]
  )

  if (!line) return <div className="empty">请选择管线</div>

  const selectedPoint = points.find((p) => p.id === selectedPointId)
  const sectionRf = line.items.find((i) => i.fitting.id === sectionFitting)
  const fittingChoices = line.items.filter((i) => i.isElbow || i.kind === 'tee' || i.kind === 'pipe')

  return (
    <div>
      <div className="toolbar">
        <PipelineSelect
          pipelines={pipelines}
          value={pipelineId}
          onChange={(id) => {
            setPipelineId(id)
            setSelectedPointId(undefined)
            setSectionFitting('')
          }}
        />
        <div className="seg" style={{ width: 380 }}>
          <button className={mode === 'ratio' ? 'active' : ''} onClick={() => setMode('ratio')}>
            剩余壁厚比例
          </button>
          <button className={mode === 'long' ? 'active' : ''} onClick={() => setMode('long')}>
            长期速率
          </button>
          <button className={mode === 'short' ? 'active' : ''} onClick={() => setMode('short')}>
            短期速率
          </button>
          <button className={mode === 'diff' ? 'active' : ''} onClick={() => setMode('diff')}>
            两期对比
          </button>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={() => nav.go('life', { pipelineId })}>
          寿命评估 →
        </button>
        <button className="btn primary" onClick={() => nav.go('plan', { pipelineId, showSuggestions: true })}>
          检验计划 / 任务单
        </button>
      </div>

      <div className="viewer-layout">
        <Viewer3D
          ref={viewerRef}
          line={line}
          mode={mode}
          periodId={periodId}
          periodA={periodA}
          periodB={periodB}
          opacity={opacity}
          selectedPointId={selectedPointId}
          onSelectPoint={(id) => setSelectedPointId(id ?? undefined)}
          suggestions={suggestions}
          showSuggestions={showSug}
          section={sectionOn && sectionRf ? { fittingId: sectionRf.fitting.id, sMm: sectionFrac * sectionRf.length } : null}
        />

        <div className="viewer-side">
          <div className="card card-pad">
            <div className="card-title">图层与剖刀</div>
            <div className="control-group">
              {mode === 'ratio' && (
                <label className="field">
                  壁厚期次
                  <select className="select" value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
                    <option value="latest">最近一期</option>
                    <option value="per-2022">2022 例行测厚</option>
                    <option value="per-2023">2023 大修</option>
                    <option value="per-2025">2025 大修</option>
                    <option value="per-2026">2026 泄漏后加测/C扫</option>
                  </select>
                </label>
              )}
              {mode === 'diff' && (
                <div className="row">
                  <label className="field" style={{ flex: 1 }}>
                    前期
                    <select className="select" value={periodA} onChange={(e) => setPeriodA(e.target.value)}>
                      <option value="per-2022">2022</option>
                      <option value="per-2023">2023</option>
                      <option value="per-2025">2025</option>
                    </select>
                  </label>
                  <label className="field" style={{ flex: 1 }}>
                    后期
                    <select className="select" value={periodB} onChange={(e) => setPeriodB(e.target.value)}>
                      <option value="per-2023">2023</option>
                      <option value="per-2025">2025</option>
                      <option value="per-2026">2026</option>
                    </select>
                  </label>
                </div>
              )}

              <div className="range-row">
                <span style={{ whiteSpace: 'nowrap' }}>外壁透明度</span>
                <input type="range" min={0.15} max={1} step={0.01} value={opacity} onChange={(e) => setOpacity(+e.target.value)} />
                <b className="mono" style={{ width: 40 }}>{opacity.toFixed(2)}</b>
              </div>

              <label className="row small" style={{ gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={showSug} onChange={(e) => setShowSug(e.target.checked)} />
                显示检验计划建议加点（{suggestions.length}）
              </label>

              <div style={{ borderTop: '1px solid var(--line)', margin: '4px 0' }} />
              <label className="row small" style={{ gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={sectionOn} onChange={(e) => setSectionOn(e.target.checked)} />
                <b>开启剖刀：显示截面圆环厚度</b>
              </label>
              {sectionOn && (
                <>
                  <select className="select" value={sectionFitting} onChange={(e) => setSectionFitting(e.target.value)}>
                    <option value="">选择要剖切的管件…</option>
                    {fittingChoices.map((rf) => (
                      <option key={rf.fitting.id} value={rf.fitting.id}>
                        {rf.code}（{rf.kind}）
                      </option>
                    ))}
                  </select>
                  {sectionRf && (
                    <div className="range-row">
                      <span>轴向位置</span>
                      <input type="range" min={0} max={1} step={0.01} value={sectionFrac} onChange={(e) => setSectionFrac(+e.target.value)} />
                      <b className="mono" style={{ width: 52 }}>{Math.round(sectionFrac * sectionRf.length)}mm</b>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {selectedPoint ? (
            <PointHistory point={selectedPoint} line={line} readings={readings} suspicious={sus} onClose={() => setSelectedPointId(undefined)} />
          ) : (
            <div className="card card-pad">
              <div className="card-title">测点详情</div>
              <div className="empty" style={{ padding: '26px 10px' }}>
                在三维管道上点击任一测点球，即可查看它的历次读数、长/短期速率、剩余寿命与建议检测日期。
                <div className="small" style={{ marginTop: 10 }}>
                  云图在 WebGPU 计算着色器中按管壁表面距离插值，外弧减薄不会穿过管心串到内弧，也不会跨管件混插。
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
