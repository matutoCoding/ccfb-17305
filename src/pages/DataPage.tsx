import React, { useMemo, useRef, useState } from 'react'
import { useData } from '../data/store'
import { PipelineSelect, Modal, Pager, usePageRows } from '../components/ui'
import { validateThicknessCsv, sampleCsv, type ImportOutcome } from '../data/csv'
import type { BadRow, ThicknessPoint } from '../domain/types'
import { KIND_SHORT } from '../domain/labels'
import { toast } from '../components/Toast'
import { useNav } from '../state/nav'

type Tab = 'points' | 'import' | 'bad' | 'cscan'

export default function DataPage({ initialPipelineId }: { initialPipelineId?: string }) {
  const { pipelines, badrows, cscans } = useData()
  const [tab, setTab] = useState<Tab>('points')
  const [pipelineId, setPipelineId] = useState(initialPipelineId ?? pipelines[0]?.id ?? '')
  const nav = useNav()
  const badCount = badrows.length

  return (
    <div>
      <div className="toolbar">
        <div className="tabs">
          <button className={`tab ${tab === 'points' ? 'active' : ''}`} onClick={() => setTab('points')}>
            测点台账
          </button>
          <button className={`tab ${tab === 'import' ? 'active' : ''}`} onClick={() => setTab('import')}>
            一期 CSV 导入
          </button>
          <button className={`tab ${tab === 'bad' ? 'active' : ''}`} onClick={() => setTab('bad')}>
            坏行隔离 {badCount > 0 && <span className="badge danger" style={{ marginLeft: 4 }}>{badCount}</span>}
          </button>
          <button className={`tab ${tab === 'cscan' ? 'active' : ''}`} onClick={() => setTab('cscan')}>
            弯头 C 扫描（{cscans.length}）
          </button>
        </div>
        <div className="spacer" />
        {tab === 'points' && <PipelineSelect pipelines={pipelines} value={pipelineId} onChange={setPipelineId} />}
        {tab === 'points' && pipelineId && (
          <button className="btn" onClick={() => nav.go('viewer', { pipelineId })}>
            🧊 三维查看
          </button>
        )}
      </div>

      {tab === 'points' && <PointsTab pipelineId={pipelineId} />}
      {tab === 'import' && <ImportTab onDone={(n) => setTab('bad')} />}
      {tab === 'bad' && <BadRowsTab />}
      {tab === 'cscan' && <CScanTab />}
    </div>
  )
}

function PointsTab({ pipelineId }: { pipelineId: string }) {
  const { points, fittings, readings, savePoint, deletePoint } = useData()
  const [q, setQ] = useState('')
  const [zone, setZone] = useState('')
  const [page, setPage] = useState(0)
  const [editing, setEditing] = useState<ThicknessPoint | null>(null)
  const lineFits = fittings.filter((f) => f.pipelineId === pipelineId)
  const fitCode = new Map(fittings.map((f) => [f.id, f.code]))

  const rows = useMemo(() => {
    return points
      .filter((p) => p.pipelineId === pipelineId)
      .filter((p) => (!zone || p.zone === zone))
      .filter((p) => !q || p.code.toLowerCase().includes(q.toLowerCase()))
      .map((p) => {
        const rs = readings.filter((r) => r.pointId === p.id)
        const latest = rs.sort((a, b) => b.date.localeCompare(a.date))[0]
        return { p, count: rs.length, latest }
      })
  }, [points, readings, pipelineId, q, zone])

  const { slice, pageCount, safe } = usePageRows(rows, page, 50)

  const newPoint = (): ThicknessPoint => ({
    id: `pt-${Date.now().toString(36)}`,
    pipelineId,
    fittingId: lineFits[0]?.id ?? '',
    code: `T-NEW-${points.length + 1}`,
    reference: 'upstream_weld',
    axialDistanceMm: 150,
    clock: 6,
    zone: 'normal',
    active: true
  })

  return (
    <>
      <div className="toolbar">
        <input className="input search" placeholder="搜索点号…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="select" style={{ width: 'auto' }} value={zone} onChange={(e) => setZone(e.target.value)}>
          <option value="">全部区域</option>
          <option value="elbow_outer">弯头外弧</option>
          <option value="elbow_inner">弯头内弧</option>
          <option value="tee_dead">三通盲端</option>
          <option value="injection_downstream">注水下游</option>
          <option value="normal">一般</option>
        </select>
        <div className="spacer" />
        <button className="btn primary" disabled={!pipelineId} onClick={() => setEditing(newPoint())}>
          ＋ 新增测点
        </button>
      </div>
      <div className="table-scroll" style={{ maxHeight: 'calc(100vh - 250px)' }}>
        <table className="data">
          <thead>
            <tr>
              <th>点号</th>
              <th>管件</th>
              <th>区域</th>
              <th>钟点</th>
              <th>轴向/基准</th>
              <th>期数</th>
              <th>最新读数</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {slice.map(({ p, count, latest }) => (
              <tr key={p.id}>
                <td className="mono">
                  <b>{p.code}</b>
                </td>
                <td className="mono small">{fitCode.get(p.fittingId) ?? '—'}</td>
                <td>
                  <ZoneBadge zone={p.zone} />
                </td>
                <td>{p.clock.toFixed(1)} 点</td>
                <td className="small">
                  {p.axialDistanceMm}mm · {refShort(p.reference)}
                </td>
                <td>{count}</td>
                <td className="mono">{latest ? `${latest.thicknessMm.toFixed(2)} (${latest.date})` : '—'}</td>
                <td>
                  <button className="btn link" onClick={() => setEditing(p)}>
                    编辑
                  </button>
                  <button
                    className="btn link"
                    style={{ color: 'var(--danger)' }}
                    onClick={async () => {
                      if (confirm(`删除测点 ${p.code} 及其读数？`)) {
                        await deletePoint(p.id)
                        toast('测点已删除', 'err')
                      }
                    }}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={safe} pageCount={pageCount} setPage={setPage} total={rows.length} />

      {editing && (
        <PointEditor
          value={editing}
          onClose={() => setEditing(null)}
          onSave={async (p) => {
            if (!p.fittingId) return toast('请选择所属管件', 'err')
            await savePoint(p)
            setEditing(null)
            toast('测点已保存，三维位置已按钟点/轴向重算')
          }}
        />
      )}
    </>
  )
}

function refShort(r: string) {
  return { upstream_weld: '距上游焊口', downstream_weld: '距下游焊口', fitting_start: '距件起点', fitting_end: '距件终点' }[r] ?? r
}

export function ZoneBadge({ zone }: { zone?: string }) {
  const map: Record<string, [string, string]> = {
    elbow_outer: ['danger', '弯头外弧'],
    elbow_inner: ['info', '弯头内弧'],
    tee_dead: ['purple', '三通盲端'],
    injection_downstream: ['warn', '注水下游'],
    normal: ['gray', '一般']
  }
  const [cls, label] = map[zone ?? 'normal'] ?? map.normal
  return <span className={`badge ${cls}`}>{label}</span>
}

function PointEditor({ value, onClose, onSave }: { value: ThicknessPoint; onClose: () => void; onSave: (p: ThicknessPoint) => void }) {
  const { fittings } = useData()
  const [p, setP] = useState<ThicknessPoint>(value)
  const lineFits = fittings.filter((f) => f.pipelineId === p.pipelineId).sort((a, b) => a.seq - b.seq)
  const set = <K extends keyof ThicknessPoint>(k: K, v: ThicknessPoint[K]) => setP((x) => ({ ...x, [k]: v }))
  return (
    <Modal
      open
      title="测点定位（管件 + 离焊口轴向距离 + 钟点）"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={() => onSave(p)}>
            保存测点
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field span2">
          点号<input className="input mono" value={p.code} onChange={(e) => set('code', e.target.value)} />
        </label>
        <label className="field">
          区域语义
          <select className="select" value={p.zone ?? 'normal'} onChange={(e) => set('zone', e.target.value as any)}>
            <option value="normal">一般</option>
            <option value="elbow_outer">弯头外弧</option>
            <option value="elbow_inner">弯头内弧</option>
            <option value="tee_dead">三通盲端</option>
            <option value="injection_downstream">注水下游</option>
          </select>
        </label>
        <label className="field span3">
          所属管件
          <select className="select" value={p.fittingId} onChange={(e) => set('fittingId', e.target.value)}>
            {lineFits.map((f) => (
              <option key={f.id} value={f.id}>
                {f.code} · {KIND_SHORT[f.kind]} · #{f.seq}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          距离基准
          <select className="select" value={p.reference} onChange={(e) => set('reference', e.target.value as any)}>
            <option value="upstream_weld">上游焊口</option>
            <option value="downstream_weld">下游焊口</option>
            <option value="fitting_start">管件起点</option>
            <option value="fitting_end">管件终点</option>
          </select>
        </label>
        <label className="field">
          轴向距离 mm<input className="input" type="number" value={p.axialDistanceMm} onChange={(e) => set('axialDistanceMm', +e.target.value)} />
        </label>
        <label className="field">
          钟点 0–12（12=正上，3=顺流向右侧，6=正下）
          <input className="input" type="number" step="0.5" min={0} max={12} value={p.clock} onChange={(e) => set('clock', +e.target.value)} />
        </label>
      </div>
      <p className="small muted" style={{ marginTop: 12 }}>
        保存后由几何内核精确落到管壁：弯头按圆环参数方程计算，外弧/内弧由几何自动判定，定位误差远小于管径 2%。
      </p>
    </Modal>
  )
}

function ImportTab({ onDone }: { onDone: (n: number) => void }) {
  const { points, pipelines, periods, addReadings, appendBadRows, saveBatch, savePeriod } = useData()
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('thickness.csv')
  const [periodId, setPeriodId] = useState(periods[periods.length - 1]?.id ?? 'per-2026')
  const [newDate, setNewDate] = useState('')
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  const [drag, setDrag] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const readFile = async (file: File) => {
    setFileName(file.name)
    setText(await file.text())
    setOutcome(null)
  }

  const validate = () => {
    const o = validateThicknessCsv(fileName, text, points, pipelines, newDate || undefined)
    setOutcome(o)
    toast(`校验完成：${o.valid.length} 行可导入，${o.bad.length} 行坏行`, o.bad.length ? 'err' : 'ok')
  }

  const confirm = async () => {
    if (!outcome) return
    let pid = periodId
    if (newDate) {
      pid = `per-${newDate}`
      await savePeriod({ id: pid, name: `${newDate} 导入期`, date: newDate, order: periods.length })
    }
    const now = new Date().toISOString()
    const readings = outcome.valid.map((v, i) => ({
      id: `rd-imp-${Date.now().toString(36)}-${i}`,
      pointId: v.point.id,
      pipelineId: v.point.pipelineId,
      periodId: pid,
      date: v.date,
      thicknessMm: v.thicknessMm,
      source: fileName
    }))
    await addReadings(readings)
    const bads: BadRow[] = outcome.bad.map((b, i) => ({ ...b, id: `bad-imp-${Date.now().toString(36)}-${i}`, createdAt: now }))
    await appendBadRows(bads)
    await saveBatch({
      id: `batch-${Date.now().toString(36)}`,
      fileName,
      periodId: pid,
      importedAt: now,
      totalRows: outcome.total,
      okRows: readings.length,
      badRows: bads.length
    })
    toast(`已导入 ${readings.length} 条读数，${bads.length} 条坏行已隔离`)
    setText('')
    setOutcome(null)
    onDone(bads.length)
  }

  return (
    <div className="grid" style={{ gridTemplateColumns: '1.1fr .9fr' }}>
      <div className="card card-pad">
        <div className="card-title">导入一期测厚 CSV</div>
        <div
          className={`dropzone ${drag ? 'drag' : ''}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDrag(true)
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDrag(false)
            const f = e.dataTransfer.files[0]
            if (f) readFile(f)
          }}
        >
          <div style={{ fontSize: 34 }}>📄</div>
          <div style={{ fontWeight: 700, margin: '8px 0 4px' }}>点击选择或把 CSV 拖到这里</div>
          <div className="small">列：点号, 日期, 厚度, 单位(mm/in), 测量人；支持中英文表头</div>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
        </div>

        <div className="row" style={{ margin: '14px 0' }}>
          <label className="field" style={{ flex: 1 }}>
            归入期次
            <select className="select" value={periodId} onChange={(e) => setPeriodId(e.target.value)} disabled={!!newDate}>
              {periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{p.date}）
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            或新检测日期
            <input className="input" type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
          </label>
        </div>

        <textarea
          className="input mono"
          rows={9}
          placeholder="也可直接把 CSV 内容粘贴到这里…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ fontSize: 12 }}
        />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => setText(sampleCsv(points))}>
            填入含坏行示例
          </button>
          <button className="btn primary" disabled={!text.trim()} onClick={validate}>
            校验 CSV
          </button>
          <div className="spacer" />
          {outcome && (
            <button className="btn primary" onClick={confirm}>
              确认导入 {outcome.valid.length} 行（坏行 {outcome.bad.length} 行隔离）
            </button>
          )}
        </div>
      </div>

      <div className="card card-pad">
        <div className="card-title">校验结果</div>
        {!outcome && <div className="empty">校验后在此预览：找不到点号、读数大于名义壁厚、单位为英寸的坏行会单独分类列出，不会入库。</div>}
        {outcome && (
          <>
            <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 14 }}>
              <div className="stat" style={{ padding: 12 }}>
                <div className="k">总行数</div>
                <div className="v" style={{ fontSize: 22 }}>{outcome.total}</div>
              </div>
              <div className="stat" style={{ padding: 12 }}>
                <div className="k">可导入</div>
                <div className="v ok" style={{ fontSize: 22 }}>{outcome.valid.length}</div>
              </div>
              <div className="stat" style={{ padding: 12 }}>
                <div className="k">坏行</div>
                <div className="v danger" style={{ fontSize: 22 }}>{outcome.bad.length}</div>
              </div>
            </div>
            <div style={{ maxHeight: 360, overflow: 'auto', display: 'grid', gap: 8 }}>
              {outcome.bad.map((b, i) => (
                <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 9 }}>
                  <div className="row" style={{ marginBottom: 5 }}>
                    <span className={`cat-tag cat-${b.category}`}>{catLabel(b.category)}</span>
                    <span className="small muted">第 {b.rowNumber} 行</span>
                  </div>
                  <div className="bad-row" style={{ marginBottom: 5 }}>{b.raw}</div>
                  <div className="small" style={{ color: 'var(--danger)' }}>{b.reason}</div>
                </div>
              ))}
              {outcome.bad.length === 0 && <div className="ok-box">✓ 没有坏行</div>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function catLabel(c: BadRow['category']) {
  return { unknown_point: '点号找不到', too_thick: '读数>名义壁厚', inch_unit: '英寸单位', parse: '解析错误', other: '其他' }[c]
}

function BadRowsTab() {
  const { badrows, removeBadRow, clearBadRows } = useData()
  const [cat, setCat] = useState('')
  const rows = badrows.filter((b) => !cat || b.category === cat)
  const counts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const b of badrows) m[b.category] = (m[b.category] ?? 0) + 1
    return m
  }, [badrows])
  return (
    <>
      <div className="toolbar">
        {Object.entries(counts).map(([c, n]) => (
          <button key={c} className={`btn sm ${cat === c ? 'primary' : ''}`} onClick={() => setCat(cat === c ? '' : c)}>
            {catLabel(c as any)} {n}
          </button>
        ))}
        <div className="spacer" />
        <button className="btn danger" onClick={() => confirm('清空全部坏行记录？') && clearBadRows()}>
          清空坏行
        </button>
      </div>
      <div className="table-scroll" style={{ maxHeight: 'calc(100vh - 230px)' }}>
        <table className="data">
          <thead>
            <tr>
              <th>文件</th>
              <th>行</th>
              <th>类别</th>
              <th>原始内容</th>
              <th>原因 / 处理建议</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td className="small">{b.fileName}</td>
                <td>{b.rowNumber}</td>
                <td>
                  <span className={`cat-tag cat-${b.category}`}>{catLabel(b.category)}</span>
                </td>
                <td>
                  <span className="bad-row">{b.raw}</span>
                </td>
                <td className="small" style={{ maxWidth: 360 }}>
                  {b.reason}
                </td>
                <td>
                  <button className="btn link" onClick={() => removeBadRow(b.id)}>
                    移除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">当前没有坏行</div>}
      </div>
    </>
  )
}

function CScanTab() {
  const { cscans, pipelines, fittings } = useData()
  const pl = new Map(pipelines.map((p) => [p.id, p]))
  const fc = new Map(fittings.map((f) => [f.id, f.code]))
  return (
    <div className="grid" style={{ gap: 16 }}>
      <CScanImport />
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(360px,1fr))' }}>
        {cscans.map((cs) => {
          const min = Math.min(...cs.values)
          const max = Math.max(...cs.values)
          return (
            <div key={cs.id} className="card card-pad">
              <div className="row">
                <b className="mono">{pl.get(cs.pipelineId)?.code}</b>
                <span className="badge purple">{fc.get(cs.fittingId)}</span>
                <div className="spacer" />
                <span className="small muted">
                  {cs.axialCount}×{cs.clockCount} 网格
                </span>
              </div>
              <div className="small muted" style={{ margin: '6px 0 10px' }}>
                轴向 {cs.axialStartMm.toFixed(0)}mm 起 / 步长 {cs.axialStepMm.toFixed(0)}mm · 钟点偏移 {cs.clockStart}~
                {(cs.clockStart + (cs.clockCount - 1) * cs.clockStepHours).toFixed(1)} 点（相对外弧） · 已贴回弯头外弧曲面参与 GPU 插值
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cs.clockCount},1fr)`, gap: 2 }}>
                {cs.values.map((v, i) => {
                  const t = (v - min) / Math.max(0.001, max - min)
                  const rC = Math.round(220 * (1 - t) + 180 * t)
                  const gC = Math.round(38 + 60 * t)
                  const bC = Math.round(60 * (1 - t) + 40 * t)
                  return <div key={i} title={`${v.toFixed(2)}mm`} style={{ aspectRatio: '1', background: `rgb(${rC},${gC},${bC})`, borderRadius: 2 }} />
                })}
              </div>
              <div className="row small muted" style={{ marginTop: 8 }}>
                <span>最薄 {min.toFixed(2)}mm</span>
                <div className="spacer" />
                <span>最厚 {max.toFixed(2)}mm</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 弯头外弧超声 C 扫矩阵导入：每行一个轴向位置，每列一个钟点偏移 */
function CScanImport() {
  const { pipelines, fittings, periods, saveCScan } = useData()
  const [pipelineId, setPipelineId] = useState(pipelines[0]?.id ?? '')
  const lineFits = fittings.filter((f) => f.pipelineId === pipelineId)
  const elbows = lineFits.filter((f) => f.kind.startsWith('elbow'))
  const [fittingId, setFittingId] = useState('')
  const [periodId, setPeriodId] = useState(periods[periods.length - 1]?.id ?? 'per-2026')
  const [axialStart, setAxialStart] = useState('500')
  const [axialStep, setAxialStep] = useState('45')
  const [clockStart, setClockStart] = useState('-2')
  const [clockStep, setClockStep] = useState('0.5')
  const [text, setText] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

  const effectiveFitting = fittingId || elbows[Math.min(3, elbows.length - 1)]?.id || lineFits[0]?.id || ''

  const fillTemplate = () => {
    const rows: string[] = []
    for (let a = 0; a < 6; a++) {
      const cells: string[] = []
      for (let c = 0; c < 9; c++) {
        const da = (a - 2.5) / 1.6
        const dc = (c - 4) / 2.2
        const g = Math.exp(-0.5 * (da * da + dc * dc))
        cells.push((8.6 - 5.2 * g + (a % 2) * 0.05).toFixed(2))
      }
      rows.push(cells.join(','))
    }
    setText(rows.join('\n'))
  }

  const doImport = async () => {
    if (!effectiveFitting) return toast('请选择弯头管件', 'err')
    const matrix = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split(/[,\t]|\s+/).filter(Boolean).map(Number))
    if (matrix.length < 2 || matrix.some((r) => r.length !== matrix[0].length || r.some((v) => !isFinite(v) || v <= 0))) {
      return toast('矩阵格式有误：需为规则的正数网格（行列数一致）', 'err')
    }
    const cs: import('../domain/types').CScanGrid = {
      id: `cs-imp-${Date.now().toString(36)}`,
      pipelineId,
      fittingId: effectiveFitting,
      periodId,
      pointCode: 'IMPORTED-CS',
      axialStartMm: +axialStart,
      axialStepMm: +axialStep,
      axialCount: matrix.length,
      clockStart: +clockStart,
      clockStepHours: +clockStep,
      clockCount: matrix[0].length,
      values: matrix.flat()
    }
    await saveCScan(cs)
    toast(`C 扫网格 ${cs.axialCount}×${cs.clockCount} 已贴回弯头曲面并参与 GPU 插值`)
    setText('')
  }

  return (
    <div className="card card-pad">
      <div className="card-title">导入弯头外弧超声 C 扫描网格</div>
      <div className="form-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        <label className="field">
          管线
          <select className="select" value={pipelineId} onChange={(e) => { setPipelineId(e.target.value); setFittingId('') }}>
            {pipelines.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
          </select>
        </label>
        <label className="field">
          弯头管件
          <select className="select" value={effectiveFitting} onChange={(e) => setFittingId(e.target.value)}>
            {elbows.length === 0 && <option value="">该线无弯头，可选任意件</option>}
            {(elbows.length ? elbows : lineFits).map((f) => <option key={f.id} value={f.id}>{f.code} · {KIND_SHORT[f.kind]}</option>)}
          </select>
        </label>
        <label className="field">
          期次
          <select className="select" value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
            {periods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="field">
          选择矩阵文件
          <input ref={fileRef} type="file" accept=".csv,.txt" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()) }} />
          <button className="btn" type="button" onClick={() => fileRef.current?.click()}>📄 读取 CSV/TXT</button>
        </label>
        <label className="field">轴向起点 mm<input className="input" value={axialStart} onChange={(e) => setAxialStart(e.target.value)} /></label>
        <label className="field">轴向步长 mm<input className="input" value={axialStep} onChange={(e) => setAxialStep(e.target.value)} /></label>
        <label className="field">钟点起点(相对外弧,小时)<input className="input" value={clockStart} onChange={(e) => setClockStart(e.target.value)} /></label>
        <label className="field">钟点步长(小时)<input className="input" value={clockStep} onChange={(e) => setClockStep(e.target.value)} /></label>
      </div>
      <textarea className="input mono" rows={5} style={{ marginTop: 12, fontSize: 12 }} placeholder={'厚度矩阵：每行一个轴向位置，列之间用逗号/Tab/空格分隔，列对应钟点偏移。例如 6 行 × 9 列…'} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn" onClick={fillTemplate}>填入外弧局部减薄模板</button>
        <div className="spacer" />
        <button className="btn primary" disabled={!text.trim()} onClick={doImport}>导入并贴回弯头曲面</button>
      </div>
    </div>
  )
}
