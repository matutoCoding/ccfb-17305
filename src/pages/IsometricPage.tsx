import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useData } from '../data/store'
import { useResolvedLine } from '../state/selectors'
import { PipelineSelect, Modal } from '../components/ui'
import { drawIsoCanvas } from '../viz/iso-drawing'
import { defaultStructureLength } from '../domain/geometry'
import { DIR_OPTIONS, KIND_LABEL, KIND_SHORT, dirLabel } from '../domain/labels'
import type { Fitting, FittingKind } from '../domain/types'
import { toast } from '../components/Toast'
import { useNav } from '../state/nav'

const KINDS = Object.keys(KIND_LABEL) as FittingKind[]

export default function IsometricPage({ initialPipelineId }: { initialPipelineId?: string }) {
  const { pipelines, fittings, saveFitting, deleteFitting } = useData()
  const nav = useNav()
  const [pipelineId, setPipelineId] = useState(initialPipelineId ?? pipelines[0]?.id ?? '')
  useEffect(() => {
    if (!pipelineId && pipelines[0]) setPipelineId(pipelines[0].id)
  }, [pipelines, pipelineId])
  const line = useResolvedLine(pipelineId)
  const lineFits = useMemo(() => fittings.filter((f) => f.pipelineId === pipelineId).sort((a, b) => a.seq - b.seq), [fittings, pipelineId])
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [editing, setEditing] = useState<Fitting | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!line || !canvasRef.current) return
    drawIsoCanvas(canvasRef.current, line, { width: 1300, height: 820, highlightFittingId: selectedId })
  }, [line, selectedId])

  if (!line) return <div className="empty">请选择管线</div>

  const newFitting = (): Fitting => {
    const seq = (lineFits.at(-1)?.seq ?? 0) + 1
    const dir = lineFits.at(-1)?.dir ?? [1, 0, 0]
    return {
      id: `ft-${Date.now().toString(36)}`,
      pipelineId,
      seq,
      code: `${line.pipeline.code}-F${String(seq).padStart(3, '0')}`,
      kind: 'pipe',
      dir: dir as [number, number, number],
      lengthMm: 1500
    }
  }

  return (
    <div>
      <div className="toolbar">
        <PipelineSelect pipelines={pipelines} value={pipelineId} onChange={setPipelineId} />
        <span className="muted small">
          {lineFits.length} 个管件 · 模型总长 {(line.totalLengthMm / 1000).toFixed(2)} m
          {line.pipeline.drawingTotalLengthM ? ` · 图纸 ${line.pipeline.drawingTotalLengthM} m` : ''}
        </span>
        <div className="spacer" />
        <button className="btn" onClick={() => nav.go('viewer', { pipelineId })}>
          🧊 在三维减薄图中查看
        </button>
        <button className="btn primary" onClick={() => setEditing(newFitting())}>
          ＋ 录入走向段
        </button>
      </div>

      {line.errors.length > 0 && (
        <div className="err-box" style={{ marginBottom: 12 }}>
          <b>⚠ 校核发现 {line.errors.length} 个问题：</b>
          {line.errors.slice(0, 6).map((e, i) => (
            <div key={i}>• {e}</div>
          ))}
        </div>
      )}
      {line.errors.length === 0 && line.warnings.length > 0 && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          {line.warnings.map((w, i) => (
            <div key={i}>• {w}</div>
          ))}
        </div>
      )}
      {line.errors.length === 0 && (
        <div className="ok-box" style={{ marginBottom: 12 }}>
          ✓ 所有走向段连接正常，弯头角度/方向匹配，总长与图纸偏差在阈值内，已自动扫出三维管道。
        </div>
      )}

      <div className="iso-layout">
        <div className="card card-pad" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div className="card-title">走向段顺序（按介质流向）</div>
          <div className="fitting-list" style={{ flex: 1 }}>
            {line.items.map((rf) => {
              const f = rf.fitting
              return (
                <div key={f.id} className={`fitting-row ${selectedId === f.id ? 'sel' : ''}`} onClick={() => setSelectedId(f.id)}>
                  <div className="seq-badge">{f.seq}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }} className="mono">
                      {f.code}
                    </div>
                    <div className="small muted">
                      {KIND_SHORT[f.kind]} · {dirLabel(f.dir)} · {rf.length >= 1000 ? `${(rf.length / 1000).toFixed(2)}m` : `${Math.round(rf.length)}mm`}
                    </div>
                  </div>
                  <div style={{ display: 'grid', gap: 4 }}>
                    <button
                      className="btn sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditing(f)
                      }}
                    >
                      编辑
                    </button>
                    <button
                      className="btn sm danger"
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (confirm(`删除 ${f.code}？`)) {
                          await deleteFitting(f.id)
                          toast('已删除走向段', 'err')
                        }
                      }}
                    >
                      删
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="card card-pad" style={{ overflow: 'auto' }}>
          <div className="card-title">等轴测走向图（自动成图）</div>
          <canvas ref={canvasRef} style={{ width: '100%', border: '1px solid var(--line)', borderRadius: 10, background: '#fff' }} />
        </div>
      </div>

      {editing && (
        <FittingEditor
          value={editing}
          dn={line.pipeline.dn}
          onClose={() => setEditing(null)}
          onSave={async (f) => {
            await saveFitting(f)
            setEditing(null)
            toast('走向段已保存，三维管道已重新扫掠')
          }}
        />
      )}
    </div>
  )
}

function FittingEditor({ value, dn, onClose, onSave }: { value: Fitting; dn: number; onClose: () => void; onSave: (f: Fitting) => void }) {
  const [f, setF] = useState<Fitting>(value)
  const set = <K extends keyof Fitting>(k: K, v: Fitting[K]) => setF((x) => ({ ...x, [k]: v }))
  const isElbow = f.kind.startsWith('elbow')
  return (
    <Modal
      open
      title={`录入/编辑走向段 · ${f.code}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={() => onSave(f)}>
            保存并重新扫掠
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          顺序号<input className="input" type="number" value={f.seq} onChange={(e) => set('seq', +e.target.value)} />
        </label>
        <label className="field span2">
          管件编号<input className="input mono" value={f.code} onChange={(e) => set('code', e.target.value)} />
        </label>
        <label className="field">
          管件类型
          <select className="select" value={f.kind} onChange={(e) => set('kind', e.target.value as FittingKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          流出方向
          <select className="select" value={JSON.stringify(f.dir)} onChange={(e) => set('dir', JSON.parse(e.target.value))}>
            {DIR_OPTIONS.map((o) => (
              <option key={o.label} value={JSON.stringify(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {isElbow ? '弯曲半径 R mm（0=按标准自动）' : '长度 / 结构长度 mm'}
          <input
            className="input"
            type="number"
            value={f.lengthMm}
            onChange={(e) => set('lengthMm', +e.target.value)}
            placeholder={isElbow ? `长半径默认 ${1.5 * dn} / 短半径 ${dn}` : `默认 ${defaultStructureLength(f.kind, dn)}`}
          />
          {!isElbow && (
            <span className="hint">
              <a
                onClick={() => set('lengthMm', defaultStructureLength(f.kind, dn))}
                style={{ cursor: 'pointer' }}
              >
                填入 {KIND_SHORT[f.kind]} 默认结构长度
              </a>
            </span>
          )}
        </label>
        {(f.kind === 'reducer_conc' || f.kind === 'reducer_ecc') && (
          <label className="field">
            小头 DN2
            <input className="input" type="number" value={f.dn2 ?? dn / 2} onChange={(e) => set('dn2', +e.target.value)} />
          </label>
        )}
        {f.kind === 'reducer_ecc' && (
          <label className="field">
            偏心侧
            <select className="select" value={f.eccSide ?? 'bottom'} onChange={(e) => set('eccSide', e.target.value as any)}>
              <option value="bottom">底平</option>
              <option value="top">顶平</option>
              <option value="left">左偏心</option>
              <option value="right">右偏心</option>
            </select>
          </label>
        )}
      </div>
      <p className="small muted" style={{ marginTop: 14, lineHeight: 1.7 }}>
        规则：直管沿当前流向延伸；弯头按入/出口方向自动求弯曲平面与圆心，90°/45° 夹角不符会直接报“走向接不上”；
        法兰、阀门按 DN 给默认结构长度。相邻段在同一坐标系精确拼接。
      </p>
    </Modal>
  )
}
