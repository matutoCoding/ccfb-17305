import React, { useMemo, useState } from 'react'
import { useData } from '../data/store'
import { useResolvedLines } from '../state/selectors'
import { buildPipelineLifeRows, toCsv, downloadTextFile, type PipelineLifeRow } from '../domain/life-table'
import { assessFitting } from '../domain/analysis'
import { NOW } from '../domain/now'
import { Modal, StatusBadge } from '../components/ui'
import { useNav } from '../state/nav'
import { toast } from '../components/Toast'

export default function LifePage({ initialPipelineId }: { initialPipelineId?: string }) {
  const { points, readings } = useData()
  const lines = useResolvedLines()
  const nav = useNav()
  const [q, setQ] = useState('')
  const [onlyRisk, setOnlyRisk] = useState(false)
  const [detail, setDetail] = useState<PipelineLifeRow | null>(null)

  const rows = useMemo(() => buildPipelineLifeRows(lines, points, readings), [lines, points, readings])
  const filtered = rows
    .filter((r) => !initialPipelineId || r.pipelineId === initialPipelineId)
    .filter((r) => !q || `${r.code}${r.block}${r.medium}`.toLowerCase().includes(q.toLowerCase()))
    .filter((r) => !onlyRisk || r.status === 'below_tmin' || r.status === 'near_end')
    .sort((a, b) => {
      const rank = (s: string) => (s === 'below_tmin' ? 0 : s === 'near_end' ? 1 : s === 'ok' ? 2 : 3)
      if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status)
      return a.remainingLifeYears - b.remainingLifeYears
    })

  const exportCsv = () => {
    const csv = toCsv([
      ['管线号', '单元', '介质', 'DN', '材质', 'tMin_mm', '名义壁厚', '最不利管件', '最不利点号', '最薄_mm', 'tMin占比', '控制速率_mm每年', '剩余寿命_年', '下次检测日期', '状态'],
      ...rows.map((r) => [
        r.code,
        r.block,
        r.medium,
        r.dn,
        r.material,
        r.tMin.toFixed(2),
        r.nominal,
        r.worst?.code ?? '',
        r.worst?.worstPointCode ?? '',
        r.worst?.latestMinMm?.toFixed(2) ?? '',
        r.worst ? (r.worst.ratio * 100).toFixed(0) + '%' : '',
        r.governingRate.toFixed(3),
        isFinite(r.remainingLifeYears) ? r.remainingLifeYears.toFixed(2) : '>30 / 无明显减薄',
        r.nextDate ?? '',
        statusText(r.status)
      ])
    ])
    downloadTextFile(`API570剩余寿命评估_${NOW.toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8')
    toast('寿命评估表已导出（与三维弹窗同一计算结果）')
  }

  const riskCount = rows.filter((r) => r.status === 'below_tmin' || r.status === 'near_end').length

  return (
    <div>
      <div className="stat-grid" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="k">评估管线</div>
          <div className="v brand">{rows.length}</div>
        </div>
        <div className="stat">
          <div className="k">低于最小壁厚</div>
          <div className="v danger">{rows.filter((r) => r.status === 'below_tmin').length}</div>
        </div>
        <div className="stat">
          <div className="k">寿命不足两周期</div>
          <div className="v warn">{rows.filter((r) => r.status === 'near_end').length}</div>
        </div>
        <div className="stat">
          <div className="k">需重点关注合计</div>
          <div className="v">{riskCount}</div>
        </div>
      </div>

      <div className="toolbar">
        <input className="input search" placeholder="搜索管线号/单元/介质…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="row small" style={{ gap: 7, cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyRisk} onChange={(e) => setOnlyRisk(e.target.checked)} />
          只看风险管线
        </label>
        <div className="spacer" />
        <button className="btn primary" onClick={exportCsv}>
          ⬇ 导出寿命评估 CSV
        </button>
      </div>

      <div className="table-scroll" style={{ maxHeight: 'calc(100vh - 280px)' }}>
        <table className="data">
          <thead>
            <tr>
              <th>管线号 / 单元</th>
              <th>DN/材质</th>
              <th>tMin</th>
              <th>最不利管件 / 点</th>
              <th>最薄 / tMin</th>
              <th>控制速率</th>
              <th>剩余寿命</th>
              <th>下次检测</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.pipelineId}
                className="clickable"
                onClick={() => nav.go('viewer', { pipelineId: r.pipelineId, pointId: r.worst?.worstPointId, mode: 'ratio' })}
              >
                <td>
                  <b className="mono">{r.code}</b>
                  <div className="small muted">{r.block}</div>
                </td>
                <td className="small">
                  DN{r.dn} · {r.material}
                </td>
                <td className="mono">{r.tMin.toFixed(2)}</td>
                <td>
                  <span className="mono small">{r.worst?.code ?? '—'}</span>
                  {r.worst?.worstPointCode && <div className="small muted mono">{r.worst.worstPointCode}</div>}
                </td>
                <td>
                  {r.worst && isFinite(r.worst.latestMinMm) ? (
                    <>
                      <b className="mono">{r.worst.latestMinMm.toFixed(2)}</b>
                      <div className={`small ${r.worst.ratio < 1 ? '' : 'muted'}`} style={{ color: r.worst.ratio < 1 ? 'var(--danger)' : undefined }}>
                        {(r.worst.ratio * 100).toFixed(0)}%
                      </div>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="mono">{r.governingRate ? r.governingRate.toFixed(2) : '—'} mm/y</td>
                <td>
                  {r.status === 'below_tmin' ? (
                    <b style={{ color: 'var(--danger)' }}>已到限</b>
                  ) : isFinite(r.remainingLifeYears) ? (
                    <b style={{ color: r.remainingLifeYears < r.cycle * 2 ? 'var(--warn)' : 'var(--ok)' }}>{r.remainingLifeYears.toFixed(1)} 年</b>
                  ) : (
                    <span className="muted">无明显减薄</span>
                  )}
                </td>
                <td className="small">{r.nextDate ?? '—'}</td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button
                    className="btn link"
                    onClick={() => nav.go('viewer', { pipelineId: r.pipelineId, pointId: r.worst?.worstPointId, mode: 'ratio' })}
                  >
                    跳到三维
                  </button>
                  <button className="btn link" onClick={() => setDetail(r)}>
                    管件明细
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail && <FittingDetail row={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}

function statusText(s: string) {
  return { below_tmin: '低于最小壁厚', near_end: '剩余寿命不足两周期', ok: '受控', no_data: '无数据' }[s] ?? s
}

function FittingDetail({ row, onClose }: { row: PipelineLifeRow; onClose: () => void }) {
  const { points, readings } = useData()
  const lines = useResolvedLines()
  const nav = useNav()
  const line = lines.find((l) => l.pipeline.id === row.pipelineId)!
  const fittingRows = useMemo(() => {
    return line.items
      .map((rf) => assessFitting(line, rf.fitting.id, points, readings, NOW))
      .filter((fa) => fa.sampleCount > 0 && isFinite(fa.latestMinMm))
      .sort((a, b) => a.ratio - b.ratio)
      .slice(0, 60)
  }, [line, points, readings])

  return (
    <Modal open width={900} title={`管件级寿命明细 · ${row.code}（最不利在前）`} onClose={onClose}>
      <table className="data">
        <thead>
          <tr>
            <th>管件</th>
            <th>最不利点</th>
            <th>测点</th>
            <th>最薄 mm</th>
            <th>/tMin</th>
            <th>速率 mm/y</th>
            <th>剩余寿命</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {fittingRows.map((fa) => (
            <tr key={fa.fittingId}>
              <td className="mono">{fa.code}</td>
              <td className="mono small">{fa.worstPointCode ?? '—'}</td>
              <td>{fa.sampleCount}</td>
              <td className="mono">{fa.latestMinMm.toFixed(2)}</td>
              <td style={{ color: fa.ratio < 1 ? 'var(--danger)' : undefined }}>{(fa.ratio * 100).toFixed(0)}%</td>
              <td className="mono">{fa.governingRate ? fa.governingRate.toFixed(2) : '—'}</td>
              <td>{fa.status === 'below_tmin' ? <b className="badge danger">已到限</b> : isFinite(fa.remainingLifeYears) ? `${fa.remainingLifeYears.toFixed(1)} 年` : '—'}</td>
              <td>
                <button
                  className="btn sm primary"
                  onClick={() => {
                    onClose()
                    nav.go('viewer', { pipelineId: row.pipelineId, pointId: fa.worstPointId, fittingId: fa.fittingId, mode: 'ratio' })
                  }}
                >
                  三维定位
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  )
}
