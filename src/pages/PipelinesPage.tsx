import React, { useMemo, useState } from 'react'
import { useData } from '../data/store'
import { PIPE_SIZES, SCHEDULES, lookupOd, lookupWall, MATERIAL_STRESS } from '../domain/tables'
import type { Pipeline } from '../domain/types'
import { Modal } from '../components/ui'
import { toast } from '../components/Toast'
import { useNav } from '../state/nav'

const empty: Pipeline = {
  id: '',
  code: '',
  unit: '常减压装置',
  block: '',
  medium: '',
  opTempC: 80,
  opPressureMPa: 0.4,
  designPressureMPa: 0.6,
  material: '20#',
  allowableStressMPa: 137,
  weldEfficiency: 1,
  corrosionAllowanceMm: 3,
  dn: 200,
  schedule: 'Sch40',
  outerDiameterMm: 219.1,
  nominalWallMm: 8.18,
  inspectionCycleYears: 3,
  drawingTotalLengthM: 0
}

export default function PipelinesPage() {
  const { pipelines, fittings, points, savePipeline, deletePipeline, resetDemo } = useData()
  const nav = useNav()
  const [q, setQ] = useState('')
  const [unitFilter, setUnitFilter] = useState('')
  const [editing, setEditing] = useState<Pipeline | null>(null)

  const units = useMemo(() => Array.from(new Set(pipelines.map((p) => p.unit))), [pipelines])
  const rows = pipelines.filter(
    (p) =>
      (!unitFilter || p.unit === unitFilter) &&
      (!q || `${p.code}${p.block}${p.medium}${p.material}`.toLowerCase().includes(q.toLowerCase()))
  )

  const counts = (id: string) => ({
    f: fittings.filter((f) => f.pipelineId === id).length,
    pt: points.filter((p) => p.pipelineId === id).length
  })

  return (
    <div>
      <div className="stat-grid" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="k">管线总数</div>
          <div className="v brand">{pipelines.length}</div>
        </div>
        <div className="stat">
          <div className="k">管件记录</div>
          <div className="v">{fittings.length.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="k">测厚点</div>
          <div className="v">{points.length.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="k">装置 / 单元</div>
          <div className="v" style={{ fontSize: 20, paddingTop: 6 }}>
            {units.length} 套 · {new Set(pipelines.map((p) => p.block)).size} 单元
          </div>
        </div>
      </div>

      <div className="toolbar">
        <input className="input search" placeholder="搜索管线号 / 单元 / 介质 / 材质…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="select" style={{ width: 'auto' }} value={unitFilter} onChange={(e) => setUnitFilter(e.target.value)}>
          <option value="">全部装置</option>
          {units.map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
        <div className="spacer" />
        <button
          className="btn"
          onClick={async () => {
            if (confirm('重新生成整套演示数据？当前在页面中新增/导入的内容会被重置。')) {
              await resetDemo()
              toast('已重置为内置常减压演示数据')
            }
          }}
        >
          ↻ 重置演示数据
        </button>
        <button className="btn primary" onClick={() => setEditing({ ...empty, id: `pl-${Date.now().toString(36)}` })}>
          ＋ 新建管线档案
        </button>
      </div>

      <div className="table-scroll" style={{ maxHeight: 'calc(100vh - 300px)' }}>
        <table className="data">
          <thead>
            <tr>
              <th>管线号</th>
              <th>单元</th>
              <th>介质</th>
              <th>规格 DN / 等级</th>
              <th>外径 mm</th>
              <th>名义壁厚</th>
              <th>材质</th>
              <th>CA</th>
              <th>设计 P/T</th>
              <th>管件/测点</th>
              <th style={{ minWidth: 210 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const c = counts(p.id)
              return (
                <tr key={p.id}>
                  <td>
                    <b className="mono">{p.code}</b>
                  </td>
                  <td>{p.block}</td>
                  <td style={{ maxWidth: 220 }} className="small">
                    {p.medium}
                  </td>
                  <td>
                    DN{p.dn} <span className="badge gray">{p.schedule}</span>
                  </td>
                  <td className="mono">{p.outerDiameterMm}</td>
                  <td className="mono">{p.nominalWallMm}</td>
                  <td>{p.material}</td>
                  <td>{p.corrosionAllowanceMm}</td>
                  <td className="small">
                    {p.designPressureMPa}MPa / {p.opTempC}℃
                  </td>
                  <td className="small muted">
                    {c.f} / {c.pt}
                  </td>
                  <td>
                    <button className="btn link" onClick={() => nav.go('viewer', { pipelineId: p.id })}>
                      三维
                    </button>
                    <button className="btn link" onClick={() => nav.go('isometric', { pipelineId: p.id })}>
                      等轴测
                    </button>
                    <button className="btn link" onClick={() => setEditing(p)}>
                      编辑
                    </button>
                    <button
                      className="btn link"
                      style={{ color: 'var(--danger)' }}
                      onClick={async () => {
                        if (confirm(`删除管线 ${p.code} 及其全部管件/测点/读数？`)) {
                          await deletePipeline(p.id)
                          toast('已删除', 'err')
                        }
                      }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <PipelineEditor
          value={editing}
          onClose={() => setEditing(null)}
          onSave={async (p) => {
            if (!p.code.trim()) return toast('请填写管线号', 'err')
            await savePipeline(p)
            setEditing(null)
            toast('管线档案已保存到 IndexedDB')
          }}
        />
      )}
    </div>
  )
}

function PipelineEditor({ value, onClose, onSave }: { value: Pipeline; onClose: () => void; onSave: (p: Pipeline) => void }) {
  const [p, setP] = useState<Pipeline>(value)
  const set = <K extends keyof Pipeline>(k: K, v: Pipeline[K]) => setP((x) => ({ ...x, [k]: v }))

  const onDn = (dn: number) => {
    const od = lookupOd(dn)
    const wall = lookupWall(dn, p.schedule) ?? p.nominalWallMm
    setP((x) => ({ ...x, dn, outerDiameterMm: od, nominalWallMm: wall }))
  }
  const onSch = (sch: string) => {
    const wall = lookupWall(p.dn, sch)
    setP((x) => ({ ...x, schedule: sch, nominalWallMm: wall ?? x.nominalWallMm }))
  }
  const onMat = (m: string) => {
    const ms = MATERIAL_STRESS[m]
    setP((x) => ({ ...x, material: m, allowableStressMPa: ms?.S ?? x.allowableStressMPa, weldEfficiency: ms?.E ?? x.weldEfficiency }))
  }

  return (
    <Modal
      open
      width={900}
      title={value.code ? `管线档案 · ${value.code}` : '新建管线档案'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={() => onSave(p)}>
            保存档案
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          管线号 *<input className="input mono" value={p.code} onChange={(e) => set('code', e.target.value)} placeholder="CDU-OH-2001" />
        </label>
        <label className="field">
          装置<input className="input" value={p.unit} onChange={(e) => set('unit', e.target.value)} />
        </label>
        <label className="field">
          单元/工段<input className="input" value={p.block} onChange={(e) => set('block', e.target.value)} />
        </label>
        <label className="field span2">
          介质<input className="input" value={p.medium} onChange={(e) => set('medium', e.target.value)} />
        </label>
        <label className="field">
          材质
          <select className="select" value={p.material} onChange={(e) => onMat(e.target.value)}>
            {Object.keys(MATERIAL_STRESS).map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="field">
          公称直径 DN
          <select className="select" value={p.dn} onChange={(e) => onDn(Number(e.target.value))}>
            {PIPE_SIZES.map((r) => (
              <option key={r.dn} value={r.dn}>
                DN{r.dn}（{r.nps}）
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          壁厚等级
          <select className="select" value={p.schedule} onChange={(e) => onSch(e.target.value)}>
            {SCHEDULES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="field">
          外径 mm（自动带出，可改）
          <input className="input" type="number" value={p.outerDiameterMm} onChange={(e) => set('outerDiameterMm', +e.target.value)} />
        </label>
        <label className="field">
          名义壁厚 mm（自动带出，可改）
          <input className="input" type="number" step="0.01" value={p.nominalWallMm} onChange={(e) => set('nominalWallMm', +e.target.value)} />
        </label>
        <label className="field">
          腐蚀裕量 CA mm<input className="input" type="number" step="0.5" value={p.corrosionAllowanceMm} onChange={(e) => set('corrosionAllowanceMm', +e.target.value)} />
        </label>
        <label className="field">
          操作压力 MPa<input className="input" type="number" step="0.01" value={p.opPressureMPa} onChange={(e) => set('opPressureMPa', +e.target.value)} />
        </label>
        <label className="field">
          操作温度 ℃<input className="input" type="number" value={p.opTempC} onChange={(e) => set('opTempC', +e.target.value)} />
        </label>
        <label className="field">
          设计压力 MPa<input className="input" type="number" step="0.01" value={p.designPressureMPa} onChange={(e) => set('designPressureMPa', +e.target.value)} />
        </label>
        <label className="field">
          许用应力 [σ]^t MPa<input className="input" type="number" value={p.allowableStressMPa} onChange={(e) => set('allowableStressMPa', +e.target.value)} />
        </label>
        <label className="field">
          焊缝系数 E<input className="input" type="number" step="0.05" min={0.5} max={1} value={p.weldEfficiency} onChange={(e) => set('weldEfficiency', +e.target.value)} />
        </label>
        <label className="field">
          检验周期 年<input className="input" type="number" value={p.inspectionCycleYears} onChange={(e) => set('inspectionCycleYears', +e.target.value)} />
        </label>
        <label className="field">
          图纸总长 m（核对用，可空）
          <input className="input" type="number" step="0.1" value={p.drawingTotalLengthM ?? ''} onChange={(e) => set('drawingTotalLengthM', +e.target.value)} />
        </label>
        <label className="field span3">
          备注<textarea className="input" rows={2} value={p.note ?? ''} onChange={(e) => set('note', e.target.value)} />
        </label>
      </div>
      <div className="ok-box" style={{ marginTop: 16 }}>
        已按 DN{p.dn} / {p.schedule} 带出外径 {p.outerDiameterMm}mm、名义壁厚 {p.nominalWallMm}mm；最小要求壁厚 tMin 将按 t=P·D/[2([σ]ᵗE+PY)] 与结构下限计算。
      </div>
    </Modal>
  )
}
