import type { Pipeline, Reading, SuggestedPoint, ThicknessPoint } from './types'
import type { ResolvedLine } from './geometry'
import { assessFitting, thicknessBasis } from './analysis'
import { radialToClock } from './vec'

export interface PlanItem extends SuggestedPoint {
  pipelineCode: string
  fittingCode: string
  dn: number
  reasonDetail: string
  remainingLifeYears?: number
  ratio?: number
}

let seq = 0
function newId() {
  seq += 1
  return `sug-${Date.now().toString(36)}-${seq}`
}

/** 计算外弧钟点（弯头中点） */
export function outerClockOf(rf: ResolvedLine['items'][number], frac = 0.5): number {
  const s = rf.length * frac
  const { t } = rf.centerAt(s)
  const phi = s / (rf.bendRadius ?? 1)
  const m = rf.bendM!
  const axis = rf.bendAxis!
  // qOut = rotate(-m, axis, phi)
  const q = rotateNeg(m, axis, phi)
  return radialToClock(t, q)
}

import { rotateAround } from './vec'
function rotateNeg(m: [number, number, number], axis: [number, number, number], phi: number) {
  return rotateAround([-m[0], -m[1], -m[2]], axis, phi)
}

/**
 * 检验计划：把"剩余寿命不足两个周期"的管件，以及弯头外弧/三通盲端/
 * 注水点下游等冲刷部位覆盖不足者挑出来，给出可直接落到三维的加点位置。
 */
export function buildPlan(
  lines: ResolvedLine[],
  points: ThicknessPoint[],
  readings: Reading[],
  now: Date = new Date()
): PlanItem[] {
  return lines.flatMap((line) => buildLinePlan(line, points, readings, now))
}

export function buildLinePlan(
  line: ResolvedLine,
  points: ThicknessPoint[],
  readings: Reading[],
  now: Date = new Date()
): PlanItem[] {
  const out: PlanItem[] = []
  const iso = now.toISOString()
  {
    const p: Pipeline = line.pipeline
    const basis = thicknessBasis(p)
    const linePts = points.filter((x) => x.pipelineId === p.id && x.active !== false)

    for (const rf of line.items) {
      const fp = linePts.filter((x) => x.fittingId === rf.fitting.id)
      const fa = assessFitting(line, rf.fitting.id, points, readings, now)
      const rl = fa.remainingLifeYears
      const lifeShort = isFinite(rl) && rl! < p.inspectionCycleYears * 2
      const below = fa.status === 'below_tmin'

      const add = (
        partial: Pick<SuggestedPoint, 'reason' | 'priority' | 'clock' | 'axialDistanceMm' | 'reference' | 'zone'>,
        detail: string
      ) => {
        out.push({
          id: newId(),
          pipelineId: p.id,
          fittingId: rf.fitting.id,
          createdAt: iso,
          ...partial,
          pipelineCode: p.code,
          fittingCode: rf.code,
          dn: p.dn,
          reasonDetail: detail,
          remainingLifeYears: isFinite(rl) ? rl : undefined,
          ratio: isFinite(fa.ratio) ? fa.ratio : undefined
        })
      }

      // 1) 寿命不足两个检验周期：在最不利点附近补点/加密
      if (fa.sampleCount > 0 && (lifeShort || below)) {
        const wp = fp.find((x) => x.id === fa.worstPointId)
        const clock = wp?.clock ?? (rf.isElbow ? outerClockOf(rf) : 6)
        const axial = wp?.axialDistanceMm ?? rf.length * 0.5
        add(
          {
            reason: below ? '已低于最小要求壁厚' : '剩余寿命不足两个检验周期',
            priority: below || (rl ?? 99) < p.inspectionCycleYears ? 'high' : 'medium',
            clock,
            axialDistanceMm: axial,
            reference: wp?.reference ?? 'fitting_start',
            zone: wp?.zone ?? 'normal'
          },
          below
            ? `${rf.code} 最薄 ${fa.latestMinMm.toFixed(2)}mm < tMin ${basis.tMin.toFixed(2)}mm，建议立即测厚复查并安排更换`
            : `${rf.code} 剩余寿命 ${(rl ?? 0).toFixed(1)} 年 < 2×${p.inspectionCycleYears} 年周期；最薄 ${fa.latestMinMm.toFixed(2)}mm / tMin ${basis.tMin.toFixed(2)}mm`
        )
      }

      // 2) 弯头外弧覆盖不足（少于 2 个外弧点且无 C 扫点）
      if (rf.isElbow) {
        const outerPts = fp.filter((x) => x.zone === 'elbow_outer' || x.arcSide === 'outer')
        const hasCscan = fp.some((x) => x.isCscan)
        if (outerPts.length < 2 && !hasCscan) {
          add(
            {
              reason: '弯头外弧冲刷区测点覆盖不足',
              priority: fa.ratio < 1.5 ? 'high' : 'medium',
              clock: outerClockOf(rf, 0.5),
              axialDistanceMm: rf.length * 0.5,
              reference: 'fitting_start',
              zone: 'elbow_outer'
            },
            `${rf.code}（${rf.fitting.kind}）外弧仅有 ${outerPts.length} 个测点、无 C 扫；外弧是冲刷减薄高发区，建议至少在 0.3/0.7 弧长截面各布 1 点`
          )
        }
      }

      // 3) 三通盲端
      if (rf.kind === 'tee') {
        const dead = fp.filter((x) => x.zone === 'tee_dead')
        if (dead.length === 0) {
          add(
            {
              reason: '三通盲端/支管端冲蚀与死角覆盖缺失',
              priority: 'medium',
              clock: 0,
              axialDistanceMm: rf.length,
              reference: 'fitting_start',
              zone: 'tee_dead'
            },
            `${rf.code} 三通盲端无测厚点；盲端易沉积+冲刷，建议在支管端盖后 100mm 布点`
          )
        }
      }

      // 4) 注水点下游的逐段检查在线级别统一处理（见下）
    }

    // 4b) 注水点下游：每条注水/腐蚀管线至少 2 个 injection_downstream 点
    if (/注水|HCl|污水|中和/.test(p.medium)) {
      const injPts = linePts.filter((x) => x.zone === 'injection_downstream')
      if (injPts.length < 2 && line.items.length) {
        // 选根部阀门后第一个直管
        const target = line.items.find((i) => i.kind === 'pipe') ?? line.items[3] ?? line.items[0]
        addGlobal(line, target, {
          reason: '注水点下游强冲刷/酸性水腐蚀部位测点不足',
          priority: 'high',
          clock: 6,
          axialDistanceMm: Math.min(500, target.length * 0.4),
          reference: 'upstream_weld',
          zone: 'injection_downstream'
        }, `${p.code} 介质“${p.medium}”，注水/注入点下游 0.5–2m 为高速冲刷+HCl 腐蚀区，现有专门测点 ${injPts.length} 个，建议在下游 0.5m、1.5m 各布一点`)
      }
    }
  }

  // 高优先级在前
  const rank = { high: 0, medium: 1, low: 2 }
  return out.sort((a, b) => rank[a.priority] - rank[b.priority] || a.pipelineCode.localeCompare(b.pipelineCode))

  function addGlobal(
    line: ResolvedLine,
    rf: ResolvedLine['items'][number],
    partial: Pick<SuggestedPoint, 'reason' | 'priority' | 'clock' | 'axialDistanceMm' | 'reference' | 'zone'>,
    detail: string
  ) {
    out.push({
      id: newId(),
      pipelineId: line.pipeline.id,
      fittingId: rf.fitting.id,
      createdAt: iso,
      ...partial,
      pipelineCode: line.pipeline.code,
      fittingCode: rf.code,
      dn: line.pipeline.dn,
      reasonDetail: detail
    })
  }
}
