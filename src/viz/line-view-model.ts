import type { CScanGrid, Reading, ThicknessPoint } from '../domain/types'
import type { ResolvedFitting, ResolvedLine } from '../domain/geometry'
import { referenceToS } from '../domain/geometry'
import { radialToClock, rotateAround } from '../domain/vec'
import { assessPoint, evaluateField, type FieldSample } from '../domain/analysis'
import type { GpuMarker, GpuSample } from './gpu-renderer'

export interface MarkerVM extends GpuMarker {
  pointId?: string
  suggestionId?: string
  code?: string
}

export function fittingIndexMap(line: ResolvedLine) {
  const m = new Map<string, number>()
  line.items.forEach((rf, i) => m.set(rf.fitting.id, i))
  return m
}

/** 某期（或最近一期）每个测点的有效厚度；susSet 中的可疑读数剔除 */
export function periodThicknessMap(
  readings: Reading[],
  periodId: string | 'latest',
  susSet?: Set<string>
): Map<string, number> {
  const byPoint = new Map<string, Reading[]>()
  for (const r of readings) {
    if (susSet?.has(r.id)) continue
    if (!byPoint.has(r.pointId)) byPoint.set(r.pointId, [])
    byPoint.get(r.pointId)!.push(r)
  }
  const out = new Map<string, number>()
  for (const [pid, rs] of byPoint) {
    rs.sort((a, b) => a.date.localeCompare(b.date))
    let r: Reading | undefined
    if (periodId === 'latest') r = rs[rs.length - 1]
    else r = rs.filter((x) => x.periodId === periodId).pop()
    if (r) out.set(pid, r.thicknessMm)
  }
  return out
}

/** 把 C 扫网格按真实钟点贴回弯头曲面，展开成表面样本 */
export function cscanSamples(
  cscans: CScanGrid[],
  line: ResolvedLine,
  periodId: string | 'latest',
  fitMap: Map<string, number>
): FieldSample[] {
  const out: FieldSample[] = []
  for (const cs of cscans) {
    if (periodId !== 'latest' && cs.periodId !== periodId) continue
    if (periodId === 'latest') {
      // latest 模式下也只取该线最新一期的 C 扫（数据里都是 per-2026）
    }
    const fi = fitMap.get(cs.fittingId)
    if (fi == null) continue
    const rf = line.items[fi]
    for (let ai = 0; ai < cs.axialCount; ai++) {
      const s = cs.axialStartMm + ai * cs.axialStepMm
      if (s < 0 || s > rf.length) continue
      for (let ci = 0; ci < cs.clockCount; ci++) {
        const off = cs.clockStart + ci * cs.clockStepHours
        const clock = (outerClockAt(rf, s) + off + 120) % 12
        const psi = rf.clockToPsi(s, clock)
        const v = cs.values[ai * cs.clockCount + ci]
        if (v == null || !isFinite(v)) continue
        out.push({ fittingId: rf.fitting.id, s, psi, radius: rf.radiusAt(s), value: v })
      }
    }
  }
  return out
}

export function outerClockAt(rf: ResolvedFitting, s: number): number {
  if (!rf.isElbow || !rf.bendCenter || !rf.bendAxis || !rf.bendM || !rf.bendRadius) {
    return 6
  }
  const phi = s / rf.bendRadius
  const q = rotateAround([-rf.bendM[0], -rf.bendM[1], -rf.bendM[2]], rf.bendAxis, phi)
  const { t } = rf.centerAt(s)
  return radialToClock(t, q)
}

/** 厚度/比例模式样本：测点 + C 扫 */
export function thicknessFieldSamples(
  line: ResolvedLine,
  points: ThicknessPoint[],
  thickness: Map<string, number>,
  cscans: CScanGrid[],
  periodId: string | 'latest'
): FieldSample[] {
  const fitMap = fittingIndexMap(line)
  const out: FieldSample[] = []
  for (const pt of points) {
    if (pt.pipelineId !== line.pipeline.id || pt.active === false) continue
    const v = thickness.get(pt.id)
    if (v == null) continue
    const fi = fitMap.get(pt.fittingId)
    if (fi == null) continue
    const rf = line.items[fi]
    const { s } = referenceToS(rf, pt.reference, pt.axialDistanceMm)
    out.push({ fittingId: rf.fitting.id, s, psi: rf.clockToPsi(s, pt.clock), radius: rf.radiusAt(s), value: v })
  }
  out.push(...cscanSamples(cscans, line, periodId, fitMap))
  return out
}

export function toGpuSamples(line: ResolvedLine, samples: FieldSample[]): GpuSample[] {
  const fitMap = fittingIndexMap(line)
  const out: GpuSample[] = []
  for (const s of samples) {
    const fit = fitMap.get(s.fittingId)
    if (fit == null) continue
    out.push({ fit, s: s.s, psi: s.psi, radius: s.radius, value: s.value })
  }
  return out
}

/** 速率模式样本 */
export function rateFieldSamples(
  line: ResolvedLine,
  points: ThicknessPoint[],
  readings: Reading[],
  kind: 'long' | 'short',
  now?: Date
): FieldSample[] {
  const out: FieldSample[] = []
  for (const pt of points) {
    if (pt.pipelineId !== line.pipeline.id || pt.active === false || pt.isCscan) continue
    const a = assessPoint(line.pipeline, pt.id, readings, now)
    const rate = kind === 'long' ? a.longRate : a.shortRate
    if (rate == null) continue
    const rf = line.items.find((i) => i.fitting.id === pt.fittingId)
    if (!rf) continue
    const { s } = referenceToS(rf, pt.reference, pt.axialDistanceMm)
    out.push({ fittingId: rf.fitting.id, s, psi: rf.clockToPsi(s, pt.clock), radius: rf.radiusAt(s), value: rate })
  }
  return out
}

/** 两期差值样本（later - earlier） */
export function diffFieldSamples(
  line: ResolvedLine,
  points: ThicknessPoint[],
  readings: Reading[],
  periodA: string,
  periodB: string,
  susSet?: Set<string>
): FieldSample[] {
  const ma = periodThicknessMap(readings, periodA, susSet)
  const mb = periodThicknessMap(readings, periodB, susSet)
  const out: FieldSample[] = []
  for (const pt of points) {
    if (pt.pipelineId !== line.pipeline.id || pt.active === false) continue
    const a = ma.get(pt.id)
    const b = mb.get(pt.id)
    if (a == null || b == null) continue
    const rf = line.items.find((i) => i.fitting.id === pt.fittingId)
    if (!rf) continue
    const { s } = referenceToS(rf, pt.reference, pt.axialDistanceMm)
    out.push({
      fittingId: rf.fitting.id,
      s,
      psi: rf.clockToPsi(s, pt.clock),
      radius: rf.radiusAt(s),
      value: Math.round((b - a) * 100) / 100
    })
  }
  return out
}

/** 构造测点标记 */
export function buildMarkers(
  line: ResolvedLine,
  points: ThicknessPoint[],
  colorFor: (pt: ThicknessPoint) => [number, number, number],
  opts: { selectedId?: string; dimOther?: boolean } = {}
): MarkerVM[] {
  const markers: MarkerVM[] = []
  const baseSize = Math.max(11, Math.min(120, line.pipeline.outerDiameterMm * 0.16))
  for (const pt of points) {
    if (pt.pipelineId !== line.pipeline.id || pt.active === false || pt.isCscan) continue
    const rf = line.items.find((i) => i.fitting.id === pt.fittingId)
    if (!rf) continue
    const { s } = referenceToS(rf, pt.reference, pt.axialDistanceMm)
    const L = rf.locate(s, pt.clock)
    const selected = pt.id === opts.selectedId
    markers.push({
      pos: L.position,
      color: selected ? [1, 1, 1] : colorFor(pt),
      size: selected ? baseSize * 1.5 : baseSize,
      id: pt.id,
      pointId: pt.id,
      code: pt.code
    })
  }
  return markers
}

/** 剖面圆环厚度/颜色取值器（走与导出完全相同的 evaluateField） */
export function makeRingEvaluator(samples: FieldSample[]) {
  return {
    thicknessAt(rf: ResolvedFitting, s: number, clock: number): number {
      const psi = rf.clockToPsi(s, clock)
      const v = evaluateField(samples, rf.fitting.id, s, psi, rf.radiusAt(s), 4)
      return v ?? rf.radiusOuter * 0.1
    }
  }
}
