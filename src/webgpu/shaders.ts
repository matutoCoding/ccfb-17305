/**
 * WGSL 着色器：
 *  - compute 管线在 GPU 上按管壁表面度量做 IDW 插值，输出每域壁厚纹理；
 *  - render 管线按 (domainIndex, s, θ) 查纹理，支持剩余壁厚分档/长短期速率/差值着色、
 *    半透明外壁、任意位置剖切截面圆环。
 *
 * 与 CPU 参考实现 (src/thickness/field.ts) 同公式：
 *   d² = ds² + (R·dθ)²，dθ 取圆周最短角；样本按域隔离，不跨法兰/焊口。
 */

export const COMPUTE_WGSL = /* wgsl */ `
struct Sample { pos: vec4f, value: f32, pad: vec3f };
struct DomInfo { sMax: f32, radius: f32, count: f32, offset: f32 };
struct Config { rows: f32, cols: f32, domainCount: f32, searchRadiusFactor: f32, mode: f32, pad2: vec3f };

@group(0) @binding(0) var<uniform> cfg: Config;
@group(0) @binding(1) var<storage, read> samples: array<Sample>;
@group(0) @binding(2) var<storage, read> doms: array<DomInfo>;
@group(0) @binding(3) var outTex: texture_storage_2d<r32float, write>;

fn angDelta(a: f32, b: f32) -> f32 {
  var d = abs(a - b);
  let twoPi = 6.28318530718;
  d = d % twoPi;
  return min(d, twoPi - d);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(outTex);
  let col = gid.x;
  let row = gid.y;
  if (col >= u32(cfg.cols) || row >= dims.y) { return; }

  let twoPi = 6.28318530718;
  let rowsPerDom = u32(cfg.rows);
  let di = row / rowsPerDom;
  if (di >= arrayLength(&doms)) { return; }
  let localRow = row % rowsPerDom;
  let dom = doms[di];
  let s = (f32(localRow) + 0.5) / cfg.rows * dom.sMax;
  let theta = f32(col) / cfg.cols * twoPi;

  var wSum = 0.0;
  var vSum = 0.0;
  var nearest = 1e9;
  let start = u32(dom.offset);
  let n = u32(dom.count);
  // 搜索半径 = 4 倍外径（radius 为外半径，外径=2r），与 CPU 场构建一致
  let searchRadius = cfg.searchRadiusFactor * dom.radius * 2.0;

  for (var k = 0u; k < n; k = k + 1u) {
    let sp = samples[start + k];
    let ds = s - sp.pos.x;
    let dt = angDelta(theta, sp.pos.y);
    let d = sqrt(ds * ds + (dom.radius * dt) * (dom.radius * dt));
    if (d < nearest) { nearest = d; }
    if (d <= searchRadius) {
      if (d < 0.01) {
        textureStore(outTex, vec2i(i32(col), i32(row)), vec4f(sp.value, 0.0, 0.0, 0.0));
        return;
      }
      let w = 1.0 / (d * d);
      wSum = wSum + w;
      vSum = vSum + w * sp.value;
    }
  }
  if (wSum > 0.0) {
    textureStore(outTex, vec2i(i32(col), i32(row)), vec4f(vSum / wSum, 0.0, 0.0, 0.0));
  } else {
    textureStore(outTex, vec2i(i32(col), i32(row)), vec4f(-1.0, 0.0, 0.0, 0.0)); // 无数据哨兵
  }
}
`;

export const RENDER_WGSL = /* wgsl */ `
struct Camera { viewProj: mat4x4f, eye: vec4f };
struct Params {
  mode: f32,          // 0 剩余壁厚比 1 长期速率 2 短期速率 3 两期差值 4 原色
  opacity: f32,
  tMin: f32,
  nominal: f32,
  domainCount: f32,
  rows: f32,
  cols: f32,
  cutDomain: f32,     // 剖切域索引，-1 关闭
  cutS: f32,
  pad: vec2f,
};
@group(0) @binding(0) var<uniform> cam: Camera;
@group(0) @binding(1) var<uniform> prm: Params;
@group(0) @binding(2) var fieldTex: texture_2d<f32>;
@group(0) @binding(3) var rateTex: texture_2d<f32>;
@group(0) @binding(4) var diffTex: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> domMeta: array<vec4f>; // sMax, radius, tMin, nominal

struct VSIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) s: f32,
  @location(3) theta: f32,
  @location(4) domain: f32,
};
struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) s: f32,
  @location(2) theta: f32,
  @location(3) domain: f32,
  @location(4) world: vec3f,
};

@vertex
fn vs(in: VSIn) -> VSOut {
  var o: VSOut;
  o.clip = cam.viewProj * vec4f(in.position, 1.0);
  o.normal = in.normal;
  o.s = in.s;
  o.theta = in.theta;
  o.domain = in.domain;
  o.world = in.position;
  return o;
}

fn ratioColor(ratio: f32) -> vec3f {
  // 红(≤0.4) 橙 黄 绿 蓝(≥1.3)，纯分支实现，避免动态索引越界
  if (ratio < 0.5) { return vec3f(0.83, 0.12, 0.12); }
  if (ratio < 0.75) { return vec3f(0.95, 0.45, 0.10); }
  if (ratio < 0.95) { return vec3f(0.95, 0.80, 0.15); }
  if (ratio < 1.2) { return vec3f(0.35, 0.75, 0.30); }
  return vec3f(0.20, 0.55, 0.85);
}

fn rateColor(rate: f32) -> vec3f {
  // 0=蓝，0.5+=红
  let x = clamp(rate / 0.5, 0.0, 1.0);
  return mix(vec3f(0.2, 0.45, 0.9), vec3f(0.9, 0.15, 0.12), x);
}

fn diffColor(d: f32) -> vec3f {
  // 负=减薄红，正=增厚蓝（可疑）
  if (d < 0.0) { return mix(vec3f(1.0, 0.95, 0.9), vec3f(0.85, 0.1, 0.1), clamp(-d / 1.5, 0.0, 1.0)); }
  return mix(vec3f(0.95, 0.95, 0.95), vec3f(0.15, 0.35, 0.9), clamp(d / 0.5, 0.0, 1.0));
}

fn gridLoad(tex: texture_2d<f32>, domain: f32, r: i32, c: i32, rows: u32, cols: u32) -> f32 {
  let rr = clamp(r, 0, i32(rows) - 1);
  let cc = ((c % i32(cols)) + i32(cols)) % i32(cols);
  let baseRow = u32(domain + 0.5) * rows;
  return textureLoad(tex, vec2i(i32(cc), i32(baseRow + u32(rr))), 0).x;
}

fn sampleGrid(tex: texture_2d<f32>, domain: f32, s: f32, theta: f32) -> f32 {
  let domInfo = domMeta[u32(domain + 0.5)];
  let twoPi = 6.28318530718;
  let rows = u32(prm.rows);
  let cols = u32(prm.cols);
  // 网格单元中心在 (r+0.5)/rows；顶点 s∈[0,sMax] 映射后减 0.5 对齐
  var fr = (s / domInfo.x) * f32(rows) - 0.5;
  var fc = (theta / twoPi) * f32(cols) - 0.5;
  var r0 = i32(floor(fr));
  var c0 = i32(floor(fc));
  var tr = clamp(fr - f32(r0), 0.0, 1.0);
  var tc = clamp(fc - f32(c0), 0.0, 1.0);
  var v00 = gridLoad(tex, domain, r0, c0, rows, cols);
  var v10 = gridLoad(tex, domain, r0 + 1, c0, rows, cols);
  var v01 = gridLoad(tex, domain, r0, c0 + 1, rows, cols);
  var v11 = gridLoad(tex, domain, r0 + 1, c0 + 1, rows, cols);
  var sum = 0.0;
  var w = 0.0;
  if (v00 >= 0.0) { sum = sum + v00 * (1.0 - tr) * (1.0 - tc); w = w + (1.0 - tr) * (1.0 - tc); }
  if (v10 >= 0.0) { sum = sum + v10 * tr * (1.0 - tc); w = w + tr * (1.0 - tc); }
  if (v01 >= 0.0) { sum = sum + v01 * (1.0 - tr) * tc; w = w + (1.0 - tr) * tc; }
  if (v11 >= 0.0) { sum = sum + v11 * tr * tc; w = w + tr * tc; }
  if (w < 0.0001) { return -1.0; }
  return sum / w;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let light = normalize(vec3f(0.4, 0.85, 0.35));
  let lambert = 0.45 + 0.55 * max(dot(normalize(in.normal), light), 0.0);
  var base: vec3f;

  if (prm.mode < 0.5) {
    let t = sampleGrid(fieldTex, in.domain, in.s, in.theta);
    if (t < 0.0) { base = vec3f(0.62, 0.62, 0.66); }
    else {
      let domTMin = domMeta[u32(in.domain + 0.5)].z;
      base = ratioColor(t / domTMin);
    }
  } else if (prm.mode < 1.5) {
    let r = sampleGrid(rateTex, in.domain, in.s, in.theta);
    base = select(vec3f(0.62, 0.62, 0.66), rateColor(r), r >= 0.0);
  } else if (prm.mode < 2.5) {
    let r = sampleGrid(rateTex, in.domain, in.s, in.theta);
    base = select(vec3f(0.62, 0.62, 0.66), rateColor(r * 1.6), r >= 0.0);
  } else if (prm.mode < 3.5) {
    let d = sampleGrid(diffTex, in.domain, in.s, in.theta);
    base = select(vec3f(0.62, 0.62, 0.66), diffColor(d), d > -100.0);
  } else {
    base = vec3f(0.45, 0.55, 0.65);
  }
  return vec4f(base * lambert, prm.opacity);
}
`;

export const MARKER_WGSL = /* wgsl */ `
struct Camera { viewProj: mat4x4f, eye: vec4f };
@group(0) @binding(0) var<uniform> cam: Camera;
struct VSIn { @location(0) p: vec3f, @location(1) c: vec4f, @location(2) sz: f32 };
struct VSOut { @builtin(position) clip: vec4f, @location(0) c: vec4f, @location(1) sz: f32 };
@vertex fn vs(in: VSIn) -> VSOut {
  var o: VSOut;
  o.clip = cam.viewProj * vec4f(in.p, 1.0);
  o.c = in.c;
  o.sz = in.sz;
  return o;
}
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  return in.c;
}
`;
