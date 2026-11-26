import type { Vec3 } from '../domain/types'
import { add, cross, dot, len, norm, scale, sub } from '../domain/vec'

// 轻量轨道相机 + 列主序 mat4（WebGPU NDC z 0..1）
export class OrbitCamera {
  target: Vec3 = [0, 0, 0]
  yaw = -0.7
  pitch = 0.5
  distance = 1000
  fov = Math.PI / 4
  aspect = 1
  near = 1
  far = 100000

  position(): Vec3 {
    const cp = Math.cos(this.pitch)
    return [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw)
    ]
  }

  fitBounds(min: Vec3, max: Vec3) {
    const c: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
    const size = Math.max(...([0, 1, 2] as const).map((i) => max[i] - min[i]))
    this.target = c
    this.distance = (size / 2 / Math.tan(this.fov / 2)) * 1.35
    this.near = Math.max(1, this.distance / 1000)
    this.far = this.distance * 20
  }

  rotate(dx: number, dy: number) {
    this.yaw -= dx * 0.006
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dy * 0.006))
  }
  zoom(factor: number) {
    this.distance = Math.max(20, Math.min(this.far * 0.4, this.distance * factor))
  }
  pan(dxPx: number, dyPx: number, heightPx: number) {
    const fwd = norm(sub(this.target, this.position()))
    const right = norm(cross(fwd, [0, 1, 0]))
    const up = cross(right, fwd)
    const k = (2 * this.distance * Math.tan(this.fov / 2)) / heightPx
    this.target = add(this.target, add(scale(right, -dxPx * k), scale(up, dyPx * k)))
  }

  viewProj(): Float32Array {
    const eye = this.position()
    const view = lookAt(eye, this.target, [0, 1, 0])
    const proj = perspective(this.fov, this.aspect, this.near, this.far)
    return multiply(proj, view)
  }
}

export function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2)
  const nf = 1 / (near - far)
  // 列主序
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far * nf, -1,
    0, 0, far * near * 2 * nf, 0
  ])
}

export function lookAt(eye: Vec3, center: Vec3, up: Vec3): Float32Array {
  const z = norm(sub(eye, center))
  const x = norm(cross(up, z))
  const y = cross(z, x)
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1
  ])
}

export function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3]
    }
  }
  return out
}

/** 世界坐标 -> 屏幕像素；返回 z in [-1,1] 与可见性 */
export function projectWorld(m: Float32Array, p: Vec3, w: number, h: number) {
  const x = p[0], y = p[1], z = p[2]
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12]
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13]
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14]
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15]
  if (cw <= 0) return { x: 0, y: 0, visible: false, ndcZ: 1 }
  const nx = cx / cw
  const ny = cy / cw
  const nz = cz / cw
  return { x: (nx * 0.5 + 0.5) * w, y: (-ny * 0.5 + 0.5) * h, visible: nz >= -1 && nz <= 1, ndcZ: nz }
}

/** 从屏幕像素生成世界射线 */
export function screenRay(cam: OrbitCamera, px: number, py: number, w: number, h: number) {
  const ndcX = (px / w) * 2 - 1
  const ndcY = 1 - (py / h) * 2
  const eye = cam.position()
  const fwd = norm(sub(cam.target, eye))
  const right = norm(cross(fwd, [0, 1, 0]))
  const up = cross(right, fwd)
  const tan = Math.tan(cam.fov / 2)
  const dir = norm(add(add(fwd, scale(right, ndcX * tan * cam.aspect)), scale(up, ndcY * tan)))
  return { origin: eye, dir }
}

export function rayPointDistance(o: Vec3, d: Vec3, p: Vec3): number {
  const op = sub(p, o)
  const t = dot(op, d)
  if (t < 0) return len(op)
  return len(sub(add(o, scale(d, t)), p))
}
