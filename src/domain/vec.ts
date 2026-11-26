import type { Vec3 } from './types'

export const v = (x = 0, y = 0, z = 0): Vec3 => [x, y, z]
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
]
export const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])
export const norm = (a: Vec3): Vec3 => {
  const l = len(a)
  return l < 1e-12 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l]
}
export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b))
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t
]
export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/** 世界正上方 */
export const UP: Vec3 = [0, 1, 0]

/**
 * 钟点基：给定流向切线 t（单位），返回 top（12点方向，垂直于 t 且尽量朝正上方）
 * 与 right（3点方向）。
 *
 * 约定（定死）：
 *  - 12 点 = 世界正上方在垂直于流向平面上的投影；
 *  - 观察者站在管件上游、顺流向看，3 点在其右侧；
 *  - right = norm(cross(t, top))。
 *
 * 对竖直管（流向与 UP 平行），用世界 +Z 作为环向基准，保证唯一、可复现。
 */
export function clockBasis(tangent: Vec3): { top: Vec3; right: Vec3 } {
  const t = norm(tangent)
  let top = sub(UP, scale(t, dot(UP, t)))
  if (len(top) < 1e-6) {
    const ref: Vec3 = [0, 0, 1]
    top = sub(ref, scale(t, dot(ref, t)))
  }
  top = norm(top)
  // cross(t, top)：顺流向观察时指向右侧（已用水平管 +X 用例验证：t=+X, top=+Y => cross=+Z）
  const right = norm(cross(t, top))
  return { top, right }
}

/** 钟点(0..12)+该截面切线 -> 环向单位径向 */
export function clockRadial(tangent: Vec3, clock: number): Vec3 {
  const { top, right } = clockBasis(tangent)
  const ang = ((clock % 12) / 12) * Math.PI * 2
  // 12 点 ang=0 -> top；3 点 ang=π/2 -> right
  return norm(add(scale(top, Math.cos(ang)), scale(right, Math.sin(ang))))
}

/** 环向径向 -> 钟点(0..12)，clockRadial 的逆 */
export function radialToClock(tangent: Vec3, radial: Vec3): number {
  const { top, right } = clockBasis(tangent)
  const r = norm(radial)
  const c = dot(r, top)
  const s = dot(r, right)
  let ang = Math.atan2(s, c)
  if (ang < 0) ang += Math.PI * 2
  return (ang / (Math.PI * 2)) * 12
}

/** 两方向夹角（度） */
export function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const c = clamp(dot(norm(a), norm(b)), -1, 1)
  return (Math.acos(c) * 180) / Math.PI
}

/** 绕轴旋转向量（Rodrigues） */
export function rotateAround(vec: Vec3, axis: Vec3, rad: number): Vec3 {
  const k = norm(axis)
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return add(
    add(scale(vec, c), scale(cross(k, vec), s)),
    scale(k, dot(k, vec) * (1 - c))
  )
}
