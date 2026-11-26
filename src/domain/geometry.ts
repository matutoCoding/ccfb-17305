import type { Fitting, Pipeline, Vec3 } from './types'
import {
  add,
  angleBetweenDeg,
  clockRadial,
  cross,
  dist,
  dot,
  len,
  norm,
  radialToClock,
  rotateAround,
  scale,
  sub,
  UP
} from './vec'

/** 定位结果：世界位置 + 该点外法向 + 切线 */
export interface Located {
  position: Vec3
  normal: Vec3
  tangent: Vec3
  /** 距件起点的中心线弧长 mm */
  s: number
  /** 稳定环向角（相对弯头外弧/直管12点基准）弧度，[0,2π) */
  psi: number
  /** 该截面外半径 mm */
  radius: number
  /** 弯头外弧方向吻合度：+1 外弧, -1 内弧, 0 中性 */
  outerDot: number
}

export interface ResolvedFitting {
  fitting: Fitting
  /** 管件编号 */
  code: string
  kind: Fitting['kind']
  start: Vec3
  end: Vec3
  inTangent: Vec3
  outTangent: Vec3
  /** 中心线总长（弯头为弧长）mm */
  length: number
  od: number
  radiusOuter: number
  /** 第二端外径（大小头） */
  odEnd: number
  radiusOuterEnd: number
  isElbow: boolean
  bendRadius?: number
  bendAngleRad?: number
  bendCenter?: Vec3
  bendAxis?: Vec3
  /** 弯头起点指向圆心的单位向量 m */
  bendM?: Vec3
  /** 三通支管 */
  branch?: { start: Vec3; end: Vec3; tangent: Vec3; length: number }
  /** 任意弧长 s 处的中心线点与切线 */
  centerAt: (s: number) => { p: Vec3; t: Vec3 }
  /** 钟点+轴向(自件起点) 定位 */
  locate: (sFromStart: number, clock: number) => Located
  /** 钟点 -> 稳定环向角 psi */
  clockToPsi: (s: number, clock: number) => number
  /** 用于表面度量的半径（s 处） */
  radiusAt: (s: number) => number
}

export interface ResolvedLine {
  pipeline: Pipeline
  items: ResolvedFitting[]
  errors: string[]
  warnings: string[]
  totalLengthMm: number
  bounds: { min: Vec3; max: Vec3 }
}

const ELBOW_ANGLE: Record<string, number> = {
  elbow_lr: 90,
  elbow_sr: 90,
  elbow45: 45
}

function bendRadiusFor(kind: string, dn: number, od: number): number {
  if (kind === 'elbow_sr') return 1.0 * dn
  // 长半径 / 45 弯头 R=1.5DN（英寸制下即 1.5 NPS，工程上用 1.5DN 近似，误差极小）
  return 1.5 * dn || 1.5 * od
}

/** 结构长度缺省值（法兰/阀门），mm，近似 GB/API 结构长度 */
export function defaultStructureLength(kind: Fitting['kind'], dn: number): number {
  switch (kind) {
    case 'flange':
      return Math.max(60, dn * 0.16 + 20)
    case 'valve_gate':
      return Math.max(150, dn * 0.6 + 120)
    case 'valve_check':
      return Math.max(150, dn * 0.55 + 120)
    case 'valve_ball':
      return Math.max(120, dn * 0.5 + 100)
    case 'tee':
      return Math.max(120, dn * 0.5 + 60) * 2 // 整个直通长度
    case 'cap':
      return Math.max(40, dn * 0.2)
    default:
      return 1000
  }
}

function radiusInterp(r0: number, r1: number, t: number) {
  return r0 + (r1 - r0) * t
}

/**
 * 把顺序录入的走向段解析成精确的三维扫掠几何。
 * 任何"走向接不上"都会进 errors，但仍尽量解析后续段。
 */
export function resolveLine(pipeline: Pipeline, fittings: Fitting[]): ResolvedLine {
  const errors: string[] = []
  const warnings: string[] = []
  const sorted = [...fittings].sort((a, b) => a.seq - b.seq)

  let cursor: Vec3 = [0, 0, 0]
  let tangent: Vec3 | null = null
  const items: ResolvedFitting[] = []

  const boundsMin: Vec3 = [Infinity, Infinity, Infinity]
  const boundsMax: Vec3 = [-Infinity, -Infinity, -Infinity]
  const expand = (p: Vec3, r = 0) => {
    for (let i = 0; i < 3; i++) {
      boundsMin[i] = Math.min(boundsMin[i], p[i] - r)
      boundsMax[i] = Math.max(boundsMax[i], p[i] + r)
    }
  }

  for (let idx = 0; idx < sorted.length; idx++) {
    const f = sorted[idx]
    const od = pipeline.outerDiameterMm
    const rOuter = od / 2
    const odEnd = f.outerDiameter2Mm ?? (f.kind.startsWith('reducer') ? pipeline.outerDiameterMm : od)
    const rOuterEnd = odEnd / 2

    // 初始走向
    if (!tangent) {
      tangent = norm(f.dir)
      if (len(tangent) < 1e-6) tangent = [1, 0, 0]
    }

    const start = cursor
    const inT = norm(f.inDir ?? tangent)
    if (len(inT) < 1e-6) {
      errors.push(`#${f.seq} ${f.code}: 入口方向为零向量`)
    }

    let rf: ResolvedFitting

    const baseCommon = {
      fitting: f,
      code: f.code,
      kind: f.kind,
      start,
      od,
      radiusOuter: rOuter,
      odEnd,
      radiusOuterEnd: rOuterEnd
    }

    if (f.kind in ELBOW_ANGLE) {
      const targetAngle = ELBOW_ANGLE[f.kind]
      const outT = norm(f.dir)
      if (len(outT) < 1e-6) {
        errors.push(`#${f.seq} ${f.code}: 弯头出口方向无效`)
      }
      const measured = angleBetweenDeg(inT, outT)
      if (Math.abs(measured - targetAngle) > 2.5) {
        errors.push(
          `#${f.seq} ${f.code}: 走向接不上 —— 入/出口夹角 ${measured.toFixed(1)}°，` +
            `${f.kind} 应为 ${targetAngle}°（偏差>2.5°）`
        )
      }
      if (Math.abs(measured - 180) < 1 || measured < 1) {
        errors.push(`#${f.seq} ${f.code}: 弯头入出口方向平行/反向，无法成弧`)
      }

      // 用实际夹角成弧（即使超差也给出几何，便于在三维里看到错位）
      const theta = (measured * Math.PI) / 180 || (targetAngle * Math.PI) / 180
      let axis = norm(cross(inT, outT))
      if (len(axis) < 1e-6) axis = [0, 0, 1]
      // 若实测夹角与目标差异大，outT 可能不严格等于旋转结果；以解析旋转为准
      const bendR = f.lengthMm > 0 && f.note?.includes?.('R=') ? f.lengthMm : bendRadiusFor(f.kind, pipeline.dn, od)
      const m = norm(cross(axis, inT)) // 起点指向圆心
      const center = add(start, scale(m, bendR))
      const arcLen = bendR * theta

      const centerAt = (s: number) => {
        const phi = clampNum(s / bendR, 0, theta)
        const q = rotateAround(scale(m, -1), axis, phi) // 圆心->点 单位径向
        const p = add(center, scale(q, bendR))
        const t = norm(rotateAround(inT, axis, phi))
        return { p, t }
      }

      const endInfo = centerAt(arcLen)
      const end = endInfo.p
      const outTangent = endInfo.t

      const clockToPsi = (s: number, clock: number) => {
        const { t } = centerAt(clampNum(s, 0, arcLen))
        const radial = clockRadial(t, clock)
        // 稳定基准：弯头外弧方向 q(s)（背离圆心），psi=0 为外弧
        const phi = clampNum(s / bendR, 0, theta)
        const qOut = rotateAround(scale(m, -1), axis, phi)
        // 在垂直 t 的平面内，以 qOut 为 psi=0，axis 为 psi=π/2
        const c = dot(radial, qOut)
        const sAng = dot(radial, axis)
        let psi = Math.atan2(sAng, c)
        if (psi < 0) psi += Math.PI * 2
        return psi
      }

      const locate = (sFromStart: number, clock: number): Located => {
        const s = clampNum(sFromStart, 0, arcLen)
        const { p, t } = centerAt(s)
        const radial = clockRadial(t, clock)
        const psi = clockToPsi(s, clock)
        const radius = rOuter // 弯头等径
        const position = add(p, scale(radial, radius))
        const qOut = sub(p, center)
        const outerDot = dot(radial, norm(qOut))
        return { position, normal: radial, tangent: t, s, psi, radius, outerDot }
      }

      rf = {
        ...baseCommon,
        end,
        inTangent: inT,
        outTangent,
        length: arcLen,
        isElbow: true,
        bendRadius: bendR,
        bendAngleRad: theta,
        bendCenter: center,
        bendAxis: axis,
        bendM: m,
        centerAt,
        locate,
        clockToPsi,
        radiusAt: () => rOuter
      }
      cursor = end
      tangent = outTangent
    } else {
      // 直管类（pipe / 法兰 / 阀门 / 大小头 / 三通 / 盲端）
      const wantsDir = norm(f.dir)
      if (len(wantsDir) > 1e-6 && idx > 0 && angleBetweenDeg(wantsDir, inT) > 1.5 && f.kind === 'pipe') {
        errors.push(
          `#${f.seq} ${f.code}: 直管方向与上一件出口不一致（夹角 ${angleBetweenDeg(wantsDir, inT).toFixed(1)}°），中间应加弯头`
        )
      }
      const dir = len(inT) > 1e-6 ? inT : wantsDir
      const L = f.lengthMm > 0 ? f.lengthMm : defaultStructureLength(f.kind, pipeline.dn)
      const end = add(start, scale(dir, L))

      // 三通支管：默认朝世界正上方（或 f.dir 的正交方向），长度=DN/2 结构
      let branch: ResolvedFitting['branch']
      if (f.kind === 'tee') {
        let bt = sub(UP, scale(dir, dot(UP, dir)))
        if (len(bt) < 1e-6) bt = [0, 0, 1]
        bt = norm(bt)
        const bl = Math.max(od * 0.9, pipeline.dn * 0.5)
        const bStart = add(start, scale(dir, L / 2))
        branch = { start: bStart, end: add(bStart, scale(bt, bl)), tangent: bt, length: bl }
      }

      const centerAt = (s: number) => ({ p: add(start, scale(dir, s)), t: dir })
      const radiusAt = (s: number) => radiusInterp(rOuter, rOuterEnd, L > 0 ? clampNum(s / L, 0, 1) : 0)

      const clockToPsi = (_s: number, clock: number) => {
        // 直管：稳定角直接用钟点角（12点为 0）
        let psi = ((clock % 12) / 12) * Math.PI * 2
        if (psi < 0) psi += Math.PI * 2
        return psi
      }
      const locate = (sFromStart: number, clock: number): Located => {
        const s = clampNum(sFromStart, 0, L)
        const { p, t } = centerAt(s)
        const radial = clockRadial(t, clock)
        const radius = radiusAt(s)
        const position = add(p, scale(radial, radius))
        return { position, normal: radial, tangent: t, s, psi: clockToPsi(s, clock), radius, outerDot: 0 }
      }

      rf = {
        ...baseCommon,
        end,
        inTangent: dir,
        outTangent: dir,
        length: L,
        isElbow: false,
        branch,
        centerAt,
        locate,
        clockToPsi,
        radiusAt
      }
      cursor = end
      tangent = dir
    }

    items.push(rf)
    expand(rf.start, rf.radiusOuter)
    expand(rf.end, rf.radiusOuterEnd)
    if (rf.bendCenter) expand(rf.bendCenter, rf.bendRadius! + rf.radiusOuter)
    if (rf.branch) {
      expand(rf.branch.start, rf.radiusOuter)
      expand(rf.branch.end, rf.radiusOuter)
    }
  }

  // 总长与图纸核对
  const totalLengthMm = items.reduce((s, it) => s + it.length, 0)
  if (pipeline.drawingTotalLengthM && pipeline.drawingTotalLengthM > 0) {
    const modelM = totalLengthMm / 1000
    const diffPct = (Math.abs(modelM - pipeline.drawingTotalLengthM) / pipeline.drawingTotalLengthM) * 100
    if (diffPct > 2) {
      errors.push(
        `总长对不上图纸：模型 ${modelM.toFixed(2)} m，图纸 ${pipeline.drawingTotalLengthM.toFixed(2)} m，偏差 ${diffPct.toFixed(1)}%（阈值 2%）`
      )
    } else if (diffPct > 0.5) {
      warnings.push(`总长与图纸偏差 ${diffPct.toFixed(2)}%`)
    }
  }

  if (!isFinite(boundsMin[0])) {
    boundsMin[0] = boundsMin[1] = boundsMin[2] = -500
    boundsMax[0] = boundsMax[1] = boundsMax[2] = 500
  }

  return { pipeline, items, errors, warnings, totalLengthMm, bounds: { min: boundsMin, max: boundsMax } }
}

function clampNum(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x))
}

/** 把测点的基准焊口/端面 + 轴向距离换算成"自件起点的弧长 s"，并做越界校核 */
export function referenceToS(
  rf: ResolvedFitting,
  reference: string,
  axialDistanceMm: number
): { s: number; outOfRange: boolean } {
  let s = axialDistanceMm
  if (reference === 'downstream_weld' || reference === 'fitting_end') {
    s = rf.length - axialDistanceMm
  }
  const outOfRange = s < -1 || s > rf.length + 1
  return { s: clampNum(s, 0, rf.length), outOfRange }
}

/** 完整定位一个测点（供三维与测试共用，保证所见即所算） */
export function locatePoint(
  line: ResolvedLine,
  fittingId: string,
  reference: string,
  axialDistanceMm: number,
  clock: number
): { located: Located; rf: ResolvedFitting; outOfRange: boolean } | null {
  const rf = line.items.find((i) => i.fitting.id === fittingId)
  if (!rf) return null
  const { s, outOfRange } = referenceToS(rf, reference, axialDistanceMm)
  return { located: rf.locate(s, clock), rf, outOfRange }
}

/** 表面度量：同一管件展开坐标 (s 轴向弧长, psi 稳定环向角)，环向按周长包裹 */
export function surfaceDistance(
  a: { s: number; psi: number; radius: number },
  b: { s: number; psi: number; radius: number }
): number {
  const ds = a.s - b.s
  const r = (a.radius + b.radius) / 2
  let dpsi = Math.abs(a.psi - b.psi)
  dpsi = Math.min(dpsi, Math.PI * 2 - dpsi) // 环向包裹：外弧到内弧走半圈 π，绝不穿心
  const dc = r * dpsi
  return Math.hypot(ds, dc)
}

/** 世界坐标 -> 最近管件与表面参数（用于三维点击管道后剖面/取厚度） */
export function nearestSurfacePoint(
  line: ResolvedLine,
  worldPoint: Vec3
): { rf: ResolvedFitting; s: number; clock: number; distance: number } | null {
  let best: { rf: ResolvedFitting; s: number; clock: number; distance: number } | null = null
  for (const rf of line.items) {
    // 沿中心线粗采样找最近 s
    const steps = Math.max(8, Math.ceil(rf.length / (rf.radiusOuter / 2)))
    for (let i = 0; i <= steps; i++) {
      const s = (rf.length * i) / steps
      const { p, t } = rf.centerAt(s)
      const dCenter = dist(worldPoint, p)
      if (dCenter > rf.radiusAt(s) * 1.6 + rf.radiusOuter) continue
      // 反求钟点
      const radial = norm(sub(worldPoint, p))
      const clock = radialToClock(t, radial)
      const loc = rf.locate(s, clock)
      const d = dist(worldPoint, loc.position)
      if (!best || d < best.distance) best = { rf, s, clock, distance: d }
    }
  }
  return best
}
