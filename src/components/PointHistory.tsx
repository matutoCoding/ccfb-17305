import React, { useMemo } from 'react'
import type { Pipeline, Reading, ThicknessPoint } from '../domain/types'
import type { ResolvedLine } from '../domain/geometry'
import { assessPoint, thicknessBasis } from '../domain/analysis'
import { NOW } from '../domain/now'
import { refLabel, zoneLabel } from '../domain/task-sheet'

export function PointHistory({
  point,
  line,
  readings,
  suspicious,
  onClose,
  onLocate
}: {
  point: ThicknessPoint
  line: ResolvedLine
  readings: Reading[]
  suspicious: Set<string>
  onClose?: () => void
  onLocate?: () => void
}) {
  const a = useMemo(() => assessPoint(line.pipeline, point.id, readings, NOW), [line.pipeline, point.id, readings])
  const basis = thicknessBasis(line.pipeline)
  const rf = line.items.find((i) => i.fitting.id === point.fittingId)
  const mine = readings
    .filter((r) => r.pointId === point.id)
    .sort((x, y) => y.date.localeCompare(x.date))

  return (
    <div className="card card-pad">
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="card-title" style={{ margin: 0 }}>
          📍 {point.code}
        </div>
        <div className="spacer" />
        {onLocate && (
          <button className="btn sm" onClick={onLocate}>
            定位
          </button>
        )}
        {onClose && (
          <button className="btn sm" onClick={onClose}>
            ✕
          </button>
        )}
      </div>

      <div className="kv">
        <span className="k">所属管件</span>
        <b>{rf?.code ?? point.fittingId}</b>
        <span className="k">定位</span>
        <span>
          {refLabel(point.reference)} {point.axialDistanceMm}mm · {point.clock.toFixed(1)} 点钟
        </span>
        <span className="k">区域</span>
        <span>
          <span className={`badge ${point.zone === 'elbow_outer' ? 'danger' : point.zone === 'elbow_inner' ? 'info' : 'gray'}`}>
            {zoneLabel(point.zone ?? 'normal')}
          </span>
          {point.arcSide && point.arcSide !== 'neutral' && (
            <span className="badge purple" style={{ marginLeft: 6 }}>
              {point.arcSide === 'outer' ? '几何判定：外弧' : '几何判定：内弧'}
            </span>
          )}
        </span>
      </div>

      <div className="stat-grid" style={{ gridTemplateColumns: '1fr 1fr', margin: '14px 0' }}>
        <div className="stat" style={{ padding: '11px 12px' }}>
          <div className="k">最新厚度</div>
          <div className={`v ${a.latestThickness != null && a.latestThickness < basis.tMin ? 'danger' : ''}`} style={{ fontSize: 21 }}>
            {a.latestThickness?.toFixed(2) ?? '—'}
            <span className="u">mm</span>
          </div>
        </div>
        <div className="stat" style={{ padding: '11px 12px' }}>
          <div className="k">最小要求 tMin</div>
          <div className="v brand" style={{ fontSize: 21 }}>
            {basis.tMin.toFixed(2)}
            <span className="u">mm</span>
          </div>
        </div>
        <div className="stat" style={{ padding: '11px 12px' }}>
          <div className="k">长 / 短期速率</div>
          <div className="v" style={{ fontSize: 17, paddingTop: 5 }}>
            {a.longRate?.toFixed(2) ?? '—'} / {a.shortRate?.toFixed(2) ?? '—'}
            <span className="u">mm/y</span>
          </div>
        </div>
        <div className="stat" style={{ padding: '11px 12px' }}>
          <div className="k">剩余寿命 / 下次检测</div>
          <div className={`v ${a.status === 'below_tmin' ? 'danger' : a.status === 'near_end' ? 'warn' : 'ok'}`} style={{ fontSize: 17, paddingTop: 5 }}>
            {a.status === 'below_tmin' ? '已低于下限' : isFinite(a.remainingLifeYears ?? NaN) ? `${a.remainingLifeYears!.toFixed(1)} 年` : '速率不足'}
          </div>
          <div className="small muted">{a.nextDate ? `建议 ${a.nextDate}` : ''}</div>
        </div>
      </div>

      <div className="small muted" style={{ marginBottom: 4 }}>
        历次读数（可疑增厚不参与速率）
      </div>
      <div className="history-list">
        {mine.map((r) => {
          const sus = suspicious.has(r.id) || r.suspicious
          return (
            <div key={r.id} className={`history-row ${sus ? 'sus' : ''}`}>
              <span>{r.date}</span>
              <b className="mono">{r.thicknessMm.toFixed(2)} mm</b>
              {sus ? <span className="badge warn">可疑增厚</span> : <span className="badge ok">有效</span>}
            </div>
          )
        })}
        {mine.length === 0 && <div className="empty" style={{ padding: 16 }}>暂无读数</div>}
      </div>
    </div>
  )
}
