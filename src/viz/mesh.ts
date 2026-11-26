import type { Vec3 } from '../domain/types'
import type { ResolvedFitting, ResolvedLine } from '../domain/geometry'
import { add, cross, norm, scale, sub } from '../domain/vec'

export interface CloudMesh {
  positions: Float32Array
  normals: Float32Array
  metas: Float32Array // 每顶点 [fittingIndex, s, psi, radius]
  indices: Uint32Array
}

/** 扫掠管壁网格；顶点 meta 直接喂给计算着色器做表面距离 IDW */
export function buildCloudMesh(line: ResolvedLine, radialSeg = 32): CloudMesh {
  const pos: number[] = []
  const nrm: number[] = []
  const meta: number[] = []
  const idx: number[] = []
  const cols = radialSeg + 1

  line.items.forEach((rf, fi) => {
    const densityAxial = Math.max(2, Math.round(rf.length / Math.max(40, rf.radiusOuter * 0.85)))
    const elbowSmooth = rf.isElbow ? Math.ceil(((rf.bendAngleRad ?? 0) * 180) / Math.PI / 6) : 0
    const axSeg = Math.min(90, Math.max(densityAxial, elbowSmooth, 2))
    const base = pos.length / 3

    for (let ia = 0; ia <= axSeg; ia++) {
      const s = (rf.length * ia) / axSeg
      for (let jr = 0; jr <= radialSeg; jr++) {
        const clock = (jr / radialSeg) * 12
        const L = rf.locate(s, clock)
        pos.push(...L.position)
        nrm.push(...L.normal)
        meta.push(fi, L.s, L.psi, L.radius)
      }
    }
    for (let ia = 0; ia < axSeg; ia++) {
      for (let jr = 0; jr < radialSeg; jr++) {
        const a = base + ia * cols + jr
        const b = a + cols
        idx.push(a, b, a + 1, a + 1, b, b + 1)
      }
    }
  })

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    metas: new Float32Array(meta),
    indices: new Uint32Array(idx)
  }
}

/** 带顶点色的五金网格 */
export class ColorGeomBuilder {
  pos: number[] = []
  nrm: number[] = []
  col: number[] = []
  idx: number[] = []

  vertex(p: Vec3, n: Vec3, c: [number, number, number]) {
    const i = this.pos.length / 3
    this.pos.push(...p)
    this.nrm.push(...n)
    this.col.push(...c)
    return i
  }

  cylinder(p0: Vec3, p1: Vec3, r0: number, r1: number, color: [number, number, number], seg = 20) {
    const axis = norm(sub(p1, p0))
    if (axis[0] === 0 && axis[1] === 0 && axis[2] === 0) return
    const ref: Vec3 = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    const u = norm(cross(axis, ref))
    const v = cross(u, axis)
    const base = this.pos.length / 3
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2
      const dir = add(scale(u, Math.cos(a)), scale(v, Math.sin(a)))
      this.vertex(add(p0, scale(dir, r0)), dir, color)
      this.vertex(add(p1, scale(dir, r1)), dir, color)
    }
    for (let j = 0; j < seg; j++) {
      const a = base + j * 2
      this.idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3)
    }
  }

  box(center: Vec3, size: Vec3, color: [number, number, number]) {
    const [sx, sy, sz] = size.map((x) => x / 2)
    const corners: Vec3[] = [
      [-sx, -sy, -sz], [sx, -sy, -sz], [sx, sy, -sz], [-sx, sy, -sz],
      [-sx, -sy, sz], [sx, -sy, sz], [sx, sy, sz], [-sx, sy, sz]
    ].map((c) => add(center, c as Vec3))
    const faces = [
      [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7],
      [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]
    ]
    for (const f of faces) {
      const p0 = corners[f[0]]
      const n = norm(cross(sub(corners[f[1]], p0), sub(corners[f[2]], p0)))
      const b = this.pos.length / 3
      for (const fi of f) this.vertex(corners[fi], n, color)
      this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
    }
  }

  toMesh() {
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      colors: new Float32Array(this.col),
      indices: new Uint32Array(this.idx)
    }
  }
}

const STEEL: [number, number, number] = [0.42, 0.47, 0.55]
const FLANGE: [number, number, number] = [0.3, 0.34, 0.42]
const VALVE: [number, number, number] = [0.16, 0.34, 0.52]
const STEM: [number, number, number] = [0.72, 0.2, 0.18]

/** 法兰/阀门/三通支管/盲端等不参与壁厚云图的五金 */
export function buildHardware(line: ResolvedLine) {
  const g = new ColorGeomBuilder()
  for (const rf of line.items) {
    const r = rf.radiusOuter
    const d = rf.outTangent
    const c = (t: number): Vec3 => rf.centerAt(t).p
    if (rf.kind === 'flange') {
      g.cylinder(rf.start, rf.end, r * 1.62, r * 1.62, FLANGE, 24)
    } else if (rf.kind.startsWith('valve')) {
      const L = rf.length
      const pA = c(0)
      const pQ1 = c(L * 0.22)
      const pQ3 = c(L * 0.78)
      const pB = c(L)
      g.cylinder(pA, pQ1, r * 1.5, r * 1.15, FLANGE, 20)
      g.cylinder(pQ1, pQ3, r * 1.35, r * 1.35, VALVE, 24)
      g.cylinder(pQ3, pB, r * 1.15, r * 1.5, FLANGE, 20)
      const mid = c(L / 2)
      const stemTop = add(mid, scale([0, 1, 0], r * 1.5))
      g.cylinder(mid, stemTop, r * 0.16, r * 0.16, STEEL, 10)
      // 手轮（压扁的圆柱盘）
      g.cylinder(add(stemTop, [0, -r * 0.08, 0]), add(stemTop, [0, r * 0.08, 0]), r * 0.95, r * 0.95, STEM, 24)
    } else if (rf.kind === 'tee' && rf.branch) {
      g.cylinder(rf.branch.start, rf.branch.end, r * 0.92, r * 0.9, STEEL, 22)
      g.cylinder(rf.branch.end, add(rf.branch.end, scale(rf.branch.tangent, r * 0.35)), r * 1.15, r * 1.15, FLANGE, 22)
    } else if (rf.kind === 'cap') {
      g.cylinder(rf.start, rf.end, r * 1.05, r * 1.15, FLANGE, 22)
    }
  }
  return g.toMesh()
}

/** 低模球（测点标记） */
export function buildSphere(lat = 12, lon = 16) {
  const pos: number[] = []
  const nrm: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= lat; i++) {
    const th = (i / lat) * Math.PI
    for (let j = 0; j <= lon; j++) {
      const ph = (j / lon) * Math.PI * 2
      const n: Vec3 = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]
      pos.push(...n)
      nrm.push(...n)
    }
  }
  const cols = lon + 1
  for (let i = 0; i < lat; i++)
    for (let j = 0; j < lon; j++) {
      const a = i * cols + j
      const b = a + cols
      idx.push(a, b, a + 1, a + 1, b, b + 1)
    }
  return { positions: new Float32Array(pos), normals: new Float32Array(nrm), indices: new Uint32Array(idx) }
}

/** 剖面圆环：返回 annulus 顶点/颜色/索引（世界空间，位于 rf 的 s 截面） */
export function buildSectionRing(
  rf: ResolvedFitting,
  s: number,
  thicknessColor: (clock: number) => [number, number, number],
  seg = 80
) {
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const R = rf.radiusAt(s)
  for (let j = 0; j <= seg; j++) {
    const clock = (j / seg) * 12
    const outer = rf.locate(s, clock)
    const t = thicknessColor(clock)
    // 内半径 = 外半径 - 该钟点厚度（限制不小于 0.3R）
    const thick = thicknessValueSafe(rf, s, clock)
    const ri = Math.max(R * 0.25, R - thick)
    const innerP = add(rf.centerAt(s).p, scale(outer.normal, ri))
    positions.push(...outer.position, ...innerP)
    colors.push(...t, ...t.map((x) => x * 0.85))
  }
  for (let j = 0; j < seg; j++) {
    const a = j * 2
    indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3)
  }
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices)
  }
}

// 由外部注入的厚度取值器，避免本模块依赖 analysis 状态
let thicknessGetter: ((rf: ResolvedFitting, s: number, clock: number) => number) | null = null
export function setRingThicknessGetter(fn: typeof thicknessGetter) {
  thicknessGetter = fn
}
function thicknessValueSafe(rf: ResolvedFitting, s: number, clock: number): number {
  try {
    return thicknessGetter ? thicknessGetter(rf, s, clock) : rf.radiusOuter * 0.12
  } catch {
    return rf.radiusOuter * 0.12
  }
}
