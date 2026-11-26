/** 三维向量数学（纯函数，几何内核与拾取共用） */
export type Vec3 = [number, number, number];

export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  len: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  norm(a: Vec3): Vec3 {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l < 1e-12 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
  },
  neg: (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]],
  /** 角度制旋转向量绕单位轴 k（Rodrigues 公式） */
  rotateAroundAxis(v: Vec3, k: Vec3, angleRad: number): Vec3 {
    const c = Math.cos(angleRad);
    const s = Math.sin(angleRad);
    const d = v3.dot(k, v);
    const cross = v3.cross(k, v);
    return [
      v[0] * c + cross[0] * s + k[0] * d * (1 - c),
      v[1] * c + cross[1] * s + k[1] * d * (1 - c),
      v[2] * c + cross[2] * s + k[2] * d * (1 - c),
    ];
  },
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
  dist: (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
};

/**
 * 钟点约定：顺流向看（视线沿 d 方向），12 点=正上方，顺时针增大。
 * 返回截面上的两个正交基向量 side(3 点方向)、up(12 点方向)，均为单位向量。
 * 世界坐标 Y 轴为竖直向上。
 */
export function sectionFrame(d: Vec3): { side: Vec3; up: Vec3 } {
  const f = v3.norm(d);
  const worldUp: Vec3 = [0, 1, 0];
  let up: Vec3;
  if (Math.abs(v3.dot(f, worldUp)) > 0.999) {
    // 竖直管：水平参考取 -Z（顺流向看的"上方"基准固定，保证可复算）
    up = v3.norm(v3.sub([0, 0, 0], [0, 0, 1])); // [0,0,-1]
    if (f[1] < 0) up = [0, 0, 1]; // 流向朝下时翻转，保持顺流向看
  } else {
    // up = worldUp - (worldUp·f)f，投影到截面
    up = v3.norm(v3.sub(worldUp, v3.scale(f, v3.dot(worldUp, f))));
  }
  // side = up × f：顺流向看指向右侧（3 点）
  const side = v3.norm(v3.cross(up, f));
  return { side, up };
}

/**
 * 钟点 -> 周向角 θ（相对 12 点基准，顺时针为正，范围 [0, 2π)）
 * 12 点=0，3 点=π/2，6 点=π，9 点=3π/2
 */
export function clockToTheta(clock: number): number {
  const turns = (clock % 12) / 12; // 12 点回到 0
  return ((turns * 2 * Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
}

/** θ -> 钟点（1~12，12 表示正上方） */
export function thetaToClock(theta: number): number {
  const t = ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const clock = (t / (2 * Math.PI)) * 12;
  return clock < 1e-9 ? 12 : clock;
}

/** 截面内由 θ 求外法线（单位向量） */
export function radialNormal(side: Vec3, up: Vec3, theta: number): Vec3 {
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);
  // n = up*cosθ + side*sinθ
  return v3.norm([
    up[0] * cos + side[0] * sin,
    up[1] * cos + side[1] * sin,
    up[2] * cos + side[2] * sin,
  ]);
}

/** 由外法线反求 θ（在给定截面基下） */
export function normalToTheta(side: Vec3, up: Vec3, n: Vec3): number {
  const x = v3.dot(n, side); // sin 分量
  const y = v3.dot(n, up); // cos 分量
  const theta = Math.atan2(x, y);
  return (theta + 2 * Math.PI) % (2 * Math.PI);
}
