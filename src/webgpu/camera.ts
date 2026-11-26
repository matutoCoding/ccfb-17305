/** 轨道相机 + 最小矩阵库（列主序，匹配 WGSL） */
export type Mat4 = Float32Array;

export function perspective(fovyRad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovyRad / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

export function lookAt(eye: number[], target: number[], up: number[]): Mat4 {
  const z = norm3(sub3(eye, target));
  const x = norm3(cross3(up, z));
  const y = cross3(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1,
  ]);
}

export function identity(): Mat4 {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function sub3(a: number[], b: number[]): number[] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot3(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross3(a: number[], b: number[]): number[] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function norm3(a: number[]): number[] {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export class OrbitCamera {
  target = [0, 0, 0] as number[];
  distance = 12000;
  yaw = 0.7;
  pitch = 0.5;
  fov = (50 * Math.PI) / 180;
  near = 10;
  far = 200000;

  eye(): number[] {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw),
    ];
  }

  viewProj(aspect: number): Mat4 {
    const view = lookAt(this.eye(), this.target, [0, 1, 0]);
    const proj = perspective(this.fov, aspect, this.near, this.far);
    return mul4(proj, view);
  }

  /** 屏幕射线（世界坐标），拾取用 */
  ray(ndcX: number, ndcY: number, aspect: number): { origin: number[]; dir: number[] } {
    const eye = this.eye();
    const f = Math.tan(this.fov / 2);
    const forward = norm3(sub3(this.target, eye));
    const right = norm3(cross3(forward, [0, 1, 0]));
    const up = cross3(right, forward);
    const dir = norm3([
      forward[0] + right[0] * ndcX * f * aspect + up[0] * ndcY * f,
      forward[1] + right[1] * ndcX * f * aspect + up[1] * ndcY * f,
      forward[2] + right[2] * ndcX * f * aspect + up[2] * ndcY * f,
    ]);
    return { origin: eye, dir };
  }

  frame(bounds: { min: number[]; max: number[] }) {
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cy = (bounds.min[1] + bounds.max[1]) / 2;
    const cz = (bounds.min[2] + bounds.max[2]) / 2;
    this.target = [cx, cy, cz];
    const size = Math.max(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
      1000,
    );
    this.distance = size * 1.6;
    this.near = Math.max(1, size / 500);
    this.far = size * 30;
  }
}

function mul4(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** 射线与线段最近距离（拾取测点/中心线用） */
export function rayPointDist(origin: number[], dir: number[], p: number[]): number {
  const ox = p[0] - origin[0];
  const oy = p[1] - origin[1];
  const oz = p[2] - origin[2];
  const t = ox * dir[0] + oy * dir[1] + oz * dir[2];
  const cx = origin[0] + dir[0] * t - p[0];
  const cy = origin[1] + dir[1] * t - p[1];
  const cz = origin[2] + dir[2] * t - p[2];
  return Math.hypot(cx, cy, cz);
}
