import type { Pipeline, Reading, ThicknessPoint } from './types'
import type { ResolvedFitting, ResolvedLine } from './geometry'
import { referenceToS } from './geometry'

/** 超声测厚重复精度/测量误差阈值 mm；后期比前期厚出该值即判可疑 */
export const UT_TOLERANCE_MM = 0.5

export interface FieldSample {
  fittingId: string
  s: number
  psi: number
  radius: number
  value: number
}

/**
 * 同一管件表面距离的反距离加权插值（IDW, 幂 p）。
 * 距离采用展开表面度量 sqrt(ds² + (r·dψ_wrap)²)，环向包裹，
 * 因此外弧到内弧必须绕半圈（≈πr），绝不穿过管心走 2r 捷径。
 * 不同管件直接不参与（调用方按 fittingId 过滤），故不会跨焊口/法兰混插。
 */
export function evaluateField(
  samples: FieldSample[],
  fittingId: string,
  s: number,
  psi: number,
  radius: number,
  power = 4
): number | null {
  let wSum = 0
  let vSum = 0
  let exact: number | null = null
  for (const q of samples) {
    if (q.fittingId !== fittingId) continue
    const ds = s - q.s
    let dpsi = Math.abs(psi - q.psi)
    dpsi = Math.min(dpsi, Math.PI * 2 - dpsi)
    const r = (radius + q.radius) / 2
    const d = Math.hypot(ds, r * dpsi)
    if (d < 1e-6) {
      exact = q.value
      continue
    }
    const w = 1 / Math.pow(d / Math.max(r, 1), power) // 以半径归一，量纲无关
    wSum += w
    vSum += w * q.value
  }
  if (exact != null) return exact
  if (wSum <= 0) return null
  return vSum / wSum
}

/** B31.3 内压壁厚计算 t = P·D / [2([σ]^t·E + P·Y)]，Y 取 0.4 */
export function pressureThicknessMm(p: Pipeline, yFactor = 0.4): number {
  const P = p.designPressureMPa
  const D = p.outerDiameterMm
  const S = p.allowableStressMPa
  const E = p.weldEfficiency
  const denom = 2 * (S * E + P * yFactor)
  if (denom <= 0) return 0
  return (P * D) / denom
}

export interface ThicknessBasis {
  tPressure: number
  /** API570 最小要求壁厚（承压计算下限，退役厚度） */
  tMin: number
  /** 含腐蚀裕量的设计参考下限 */
  tWithCA: number
  nominal: number
}

export function thicknessBasis(p: Pipeline): ThicknessBasis {
  const tPressure = pressureThicknessMm(p)
  // 大口径低压管的结构下限：取外径的 0.5% 与 3mm 的较大者作为工程最小结构壁厚
  const structuralMin = Math.max(3, p.outerDiameterMm * 0.005)
  const tMin = Math.max(tPressure, structuralMin)
  return {
    tPressure,
    tMin,
    tWithCA: tMin + p.corrosionAllowanceMm,
    nominal: p.nominalWallMm
  }
}

function yearsBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso).getTime()
  const b = new Date(bIso).getTime()
  return Math.abs(b - a) / (365.25 * 24 * 3600 * 1000)
}

export interface RateResult {
  first?: Reading
  last?: Reading
  previous?: Reading
  longRate?: number // mm/y 减薄速率（正=减薄）
  shortRate?: number
  /** 评估采用的控制速率（取长/短期中可靠且更不利者） */
  governingRate?: number
  remainingLifeYears?: number
  nextIntervalYears?: number
  nextDate?: string
  status: 'no_data' | 'ok' | 'below_tmin' | 'near_end'
  suspiciousCount: number
  validCount: number
  latestThickness?: number
}

/** 标记可疑读数：后一期有效读数比前一期厚出 > 测量误差 */
export function computeSuspicious(readings: Reading[], tolerance = UT_TOLERANCE_MM): Set<string> {
  const sorted = readings
    .filter((r) => !r.excluded)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  const sus = new Set<string>()
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    // 若前一条已可疑，仍以最近一条"非可疑"做基准
    let base = prev
    let j = i - 1
    while (sus.has(base.id) && j > 0) {
      j--
      base = sorted[j]
    }
    if (sus.has(base.id)) continue
    if (cur.thicknessMm - base.thicknessMm > tolerance + 1e-9) {
      sus.add(cur.id)
    }
  }
  return sus
}

/** 单点速率与寿命。now 可注入便于测试 */
export function assessPoint(
  p: Pipeline,
  pointId: string,
  allReadings: Reading[],
  now: Date = new Date()
): RateResult {
  const basis = thicknessBasis(p)
  const mineAll = allReadings
    .filter((r) => r.pointId === pointId && !r.excluded)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  const sus = computeSuspicious(mineAll)
  const valid = mineAll.filter((r) => !sus.has(r.id))

  const result: RateResult = {
    suspiciousCount: sus.size,
    validCount: valid.length,
    status: 'no_data'
  }
  if (valid.length === 0) return result

  const first = valid[0]
  const last = valid[valid.length - 1]
  result.first = first
  result.last = last
  result.latestThickness = last.thicknessMm

  if (valid.length >= 2) {
    const yLong = yearsBetween(first.date, last.date)
    if (yLong > 1e-6) {
      result.longRate = Math.max(0, (first.thicknessMm - last.thicknessMm) / yLong)
    }
    if (valid.length >= 3) {
      const prev = valid[valid.length - 2]
      result.previous = prev
      const yShort = yearsBetween(prev.date, last.date)
      if (yShort > 1e-6) {
        result.shortRate = Math.max(0, (prev.thicknessMm - last.thicknessMm) / yShort)
      }
    } else if (valid.length === 2) {
      result.previous = valid[0]
      result.shortRate = result.longRate
    }
  }

  // 控制速率：API570 通常以长期速率为基准；短期速率只有在"足够大且显著高于长期"
  // （>0.2 mm/y 且 >1.4×长期）时才作为加速腐蚀的不利依据，避免两期 UT 噪声造成误报。
  const long = result.longRate ?? 0
  const short = result.shortRate
  let gov = long
  if (short != null && short > 0.2 && short > long * 1.4) gov = short
  gov = Math.max(0, gov)
  result.governingRate = gov

  const margin = last.thicknessMm - basis.tMin
  if (last.thicknessMm < basis.tMin) {
    result.status = 'below_tmin'
    result.remainingLifeYears = 0
    result.nextIntervalYears = 0
    result.nextDate = now.toISOString().slice(0, 10)
  } else if (gov > 0.005) {
    const rl = margin / gov
    result.remainingLifeYears = rl
    // 半年寿命法则：下次检测间隔 = min(检验周期, RL/2)
    const interval = Math.max(0, Math.min(p.inspectionCycleYears, rl / 2))
    result.nextIntervalYears = interval
    const d = new Date(now.getTime() + interval * 365.25 * 86400e3)
    result.nextDate = d.toISOString().slice(0, 10)
    result.status = rl < p.inspectionCycleYears * 2 ? 'near_end' : 'ok'
  } else {
    // 无明显减薄：按整个检验周期
    result.remainingLifeYears = Infinity
    result.nextIntervalYears = p.inspectionCycleYears
    const d = new Date(now.getTime() + p.inspectionCycleYears * 365.25 * 86400e3)
    result.nextDate = d.toISOString().slice(0, 10)
    result.status = 'ok'
  }
  return result
}

export interface FittingAssessment {
  fittingId: string
  code: string
  worstPointId?: string
  worstPointCode?: string
  /** 控制测点（即 worstPoint）的最新厚度；与三维落点面板数字严格一致 */
  latestMinMm: number
  /** 全管件绝对最薄测点厚度（可能来自另一个点，仅作参考） */
  absoluteMinMm?: number
  tMin: number
  ratio: number // latestMinMm / tMin
  governingRate: number
  remainingLifeYears: number
  nextDate?: string
  status: RateResult['status']
  sampleCount: number
}

/**
 * 汇总一个管件下所有测点。
 * 关键：只选出"同一个控制测点"，标题用的厚度/速率/剩余寿命/下次日期/状态
 * 全部来自该点，因此表格行跳到三维后看到的数字与行内数字严格一致。
 * 选点顺序：已低于 tMin 中最薄者 → 剩余寿命最小者 → 最薄者。
 */
export function assessFitting(
  line: ResolvedLine,
  fittingId: string,
  points: ThicknessPoint[],
  readings: Reading[],
  now?: Date
): FittingAssessment {
  const rf = line.items.find((i) => i.fitting.id === fittingId)
  const basis = thicknessBasis(line.pipeline)
  const fps = points.filter((pt) => pt.fittingId === fittingId && pt.active !== false && !pt.isCscan)

  const assessed = fps
    .map((pt) => ({ pt, a: assessPoint(line.pipeline, pt.id, readings, now) }))
    .filter((x) => x.a.latestThickness != null)

  if (assessed.length === 0) {
    return {
      fittingId,
      code: rf?.code ?? fittingId,
      latestMinMm: NaN,
      tMin: basis.tMin,
      ratio: NaN,
      governingRate: 0,
      remainingLifeYears: Infinity,
      status: 'no_data',
      sampleCount: fps.length
    }
  }

  const absoluteMinMm = Math.min(...assessed.map((x) => x.a.latestThickness!))
  const below = assessed.filter((x) => x.a.status === 'below_tmin')

  let gov: (typeof assessed)[number]
  if (below.length) {
    gov = below.reduce((m, x) => (x.a.latestThickness! < m.a.latestThickness! ? x : m))
  } else {
    const finiteLife = assessed.filter((x) => isFinite(x.a.remainingLifeYears ?? Infinity))
    if (finiteLife.length) {
      gov = finiteLife.reduce((m, x) => ((x.a.remainingLifeYears ?? Infinity) < (m.a.remainingLifeYears ?? Infinity) ? x : m))
    } else {
      gov = assessed.reduce((m, x) => (x.a.latestThickness! < m.a.latestThickness! ? x : m))
    }
  }

  const latestMinMm = gov.a.latestThickness!
  return {
    fittingId,
    code: rf?.code ?? fittingId,
    worstPointId: gov.pt.id,
    worstPointCode: gov.pt.code,
    latestMinMm,
    absoluteMinMm,
    tMin: basis.tMin,
    ratio: latestMinMm / basis.tMin,
    governingRate: gov.a.governingRate ?? 0,
    remainingLifeYears: gov.a.remainingLifeYears ?? Infinity,
    nextDate: gov.a.nextDate,
    status: gov.a.status,
    sampleCount: fps.length
  }
}

/** 颜色分档：剩余壁厚 / 最小要求壁厚 */
export interface Band {
  max: number
  label: string
  color: [number, number, number]
}
export const RATIO_BANDS: Band[] = [
  { max: 1.0, label: '低于最小要求 (<100%)', color: [0.75, 0.11, 0.16] },
  { max: 1.2, label: '严重减薄 (100–120%)', color: [0.93, 0.35, 0.14] },
  { max: 1.5, label: '明显减薄 (120–150%)', color: [0.95, 0.61, 0.07] },
  { max: 2.0, label: '适度减薄 (150–200%)', color: [0.95, 0.85, 0.25] },
  { max: Infinity, label: '良好 (>200%)', color: [0.2, 0.69, 0.42] }
]

export function ratioColor(ratio: number): [number, number, number] {
  if (!isFinite(ratio)) return [0.62, 0.65, 0.7]
  for (const b of RATIO_BANDS) if (ratio < b.max) return b.color
  return RATIO_BANDS[RATIO_BANDS.length - 1].color
}

/** 速率色带 0..1.5 mm/y */
export function rateColor(rate: number, maxRate = 1.2): [number, number, number] {
  if (!isFinite(rate)) return [0.62, 0.65, 0.7]
  const t = Math.min(1, Math.max(0, rate / maxRate))
  // 绿 -> 黄 -> 红
  if (t < 0.5) {
    const k = t / 0.5
    return [lerp(0.2, 0.95, k), lerp(0.69, 0.85, k), lerp(0.42, 0.25, k)]
  }
  const k = (t - 0.5) / 0.5
  return [lerp(0.95, 0.75, k), lerp(0.85, 0.11, k), lerp(0.25, 0.16, k)]
}

/** 差值色：负（减薄）红，零附近浅，正（增厚/可疑）蓝 */
export function diffColor(diff: number, maxAbs = 1.5): [number, number, number] {
  const t = Math.max(-1, Math.min(1, diff / maxAbs))
  if (t < 0) {
    const k = -t
    return [lerp(0.85, 0.75, k), lerp(0.85, 0.15, k), lerp(0.85, 0.18, k)]
  }
  return [lerp(0.92, 0.15, t), lerp(0.92, 0.4, t), lerp(0.95, 0.75, t)]
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

/** 由测点数 + 读数构造某期的表面样本（C 扫描网格另行展开后并入） */
export function buildPointSamples(
  line: ResolvedLine,
  points: ThicknessPoint[],
  thicknessByPoint: Map<string, number>
): FieldSample[] {
  const out: FieldSample[] = []
  for (const pt of points) {
    const value = thicknessByPoint.get(pt.id)
    if (value == null || pt.active === false) continue
    const rf = line.items.find((i) => i.fitting.id === pt.fittingId)
    if (!rf) continue
    const { s } = referenceToS(rf, pt.reference, pt.axialDistanceMm)
    const psi = rf.clockToPsi(s, pt.clock)
    out.push({ fittingId: rf.fitting.id, s, psi, radius: rf.radiusAt(s), value })
  }
  return out
}
