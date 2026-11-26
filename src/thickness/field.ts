/**
 * 壁厚场（CPU 参考实现，与 WGSL compute 同一数学）。
 *
 * 硬约束：
 * 1. 每个管件域独立建场，样本不跨域 —— 法兰/焊口两侧绝不混插；
 * 2. 距离用管面度量 d²=ds²+(R·dθ)²，dθ 取圆周最短角 —— 不会穿过管心；
 * 3. 弯头外弧/内弧在 θ 方向天然相隔半个圆周，IDW 权重被表面距离压到接近 0；
 * 4. 无样本域返回 NaN，渲染为灰色，不拿名义壁厚冒充实测。
 */
import { FittingDomain } from '../geometry/centerline';
import { surfaceMetric } from '../geometry/placement';

export interface FieldSample {
  domainId: string;
  s: number;
  theta: number;
  thickness: number;
  pointNo?: string;
}

export interface FieldGrid {
  domainId: string;
  rows: number; // 轴向
  cols: number; // 周向
  sMin: number;
  sMax: number;
  /** rows*cols，[row*cols+col]，col=0 对应 θ=0（12 点） */
  values: Float32Array;
  /** 每个网格最近样本的表面距离 mm，用于覆盖率/置信度展示 */
  nearestDist: Float32Array;
  hasData: boolean;
}

export interface ThicknessField {
  grids: Map<string, FieldGrid>;
  samples: FieldSample[];
}

export const IDW_NEIGHBORS = 8;
/** 超过该表面距离(mm)不再让样本参与插值，避免远端数据拉平局部减薄 */
export const IDW_SEARCH_RADIUS_FACTOR = 4; // 相对管径倍数
const IDW_POWER = 2;

function angularDelta(a: number, b: number): number {
  let d = Math.abs(a - b);
  return Math.min(d, 2 * Math.PI - d);
}

/** 单点 IDW 查询（场纹理之外的任意位置查询，如剖切、导出表，统一走这里） */
export function sampleField(
  grid: FieldGrid,
  dom: FittingDomain,
  s: number,
  theta: number,
  localSamples: FieldSample[],
): number {
  if (!grid.hasData || localSamples.length === 0) return NaN;
  const searchR = dom.diameter * IDW_SEARCH_RADIUS_FACTOR;
  const weighted: { d: number; t: number }[] = [];
  for (const sp of localSamples) {
    const d = surfaceMetric(dom, { s, theta }, { s: sp.s, theta: sp.theta });
    if (d <= searchR) weighted.push({ d, t: sp.thickness });
  }
  if (weighted.length === 0) return NaN;
  weighted.sort((a, b) => a.d - b.d);
  const near = weighted.slice(0, IDW_NEIGHBORS);
  let wSum = 0;
  let vSum = 0;
  for (const w of near) {
    if (w.d < 1e-6) return w.t;
    const wt = 1 / Math.pow(w.d, IDW_POWER);
    wSum += wt;
    vSum += wt * w.t;
  }
  return vSum / wSum;
}

export function buildField(
  domains: FittingDomain[],
  samples: FieldSample[],
  rowsPerMeter = 40,
  cols = 32,
): ThicknessField {
  const byDomain = new Map<string, FieldSample[]>();
  for (const sp of samples) {
    if (!byDomain.has(sp.domainId)) byDomain.set(sp.domainId, []);
    byDomain.get(sp.domainId)!.push(sp);
  }

  const grids = new Map<string, FieldGrid>();
  for (const dom of domains) {
    const local = byDomain.get(dom.fittingId) ?? [];
    const rows = Math.max(4, Math.ceil((dom.length / 1000) * rowsPerMeter));
    const values = new Float32Array(rows * cols).fill(NaN);
    const nearestDist = new Float32Array(rows * cols).fill(NaN);
    const grid: FieldGrid = {
      domainId: dom.fittingId,
      rows,
      cols,
      sMin: 0,
      sMax: dom.length,
      values,
      nearestDist,
      hasData: local.length > 0,
    };
    if (local.length > 0) {
      const searchR = dom.diameter * IDW_SEARCH_RADIUS_FACTOR;
      for (let r = 0; r < rows; r++) {
        const s = dom.length * ((r + 0.5) / rows);
        for (let c = 0; c < cols; c++) {
          const theta = (c / cols) * Math.PI * 2;
          let nearest = Infinity;
          const weighted: { d: number; t: number }[] = [];
          for (const sp of local) {
            const d = surfaceMetric(dom, { s, theta }, sp);
            if (d < nearest) nearest = d;
            if (d <= searchR) weighted.push({ d, t: sp.thickness });
          }
          nearestDist[r * cols + c] = nearest;
          if (weighted.length === 0) continue;
          weighted.sort((a, b) => a.d - b.d);
          const near = weighted.slice(0, IDW_NEIGHBORS);
          let wSum = 0;
          let vSum = 0;
          for (const w of near) {
            if (w.d < 1e-6) {
              vSum = w.t;
              wSum = 1;
              break;
            }
            const wt = 1 / Math.pow(w.d, IDW_POWER);
            wSum += wt;
            vSum += wt * w.t;
          }
          values[r * cols + c] = vSum / wSum;
        }
      }
    }
    grids.set(dom.fittingId, grid);
  }
  return { grids, samples };
}

/** 双线性取网格值（渲染纹理采样的 CPU 对照） */
export function lookupGrid(grid: FieldGrid, s: number, theta: number): number {
  const fr = ((s - grid.sMin) / Math.max(1e-9, grid.sMax - grid.sMin)) * grid.rows - 0.5;
  const fc = (theta / (2 * Math.PI)) * grid.cols - 0.5;
  const r0 = Math.floor(fr);
  const c0 = Math.floor(fc);
  const tr = fr - r0;
  const tc = fc - c0;
  const at = (r: number, c: number): number => {
    const rr = Math.max(0, Math.min(grid.rows - 1, r));
    const cc = ((c % grid.cols) + grid.cols) % grid.cols; // 周向环绕
    return grid.values[rr * grid.cols + cc];
  };
  const v00 = at(r0, c0);
  const v10 = at(r0 + 1, c0);
  const v01 = at(r0, c0 + 1);
  const v11 = at(r0 + 1, c0 + 1);
  // NaN 不参与平均
  let sum = 0;
  let w = 0;
  const mix = (v: number, wt: number) => {
    if (Number.isFinite(v)) {
      sum += v * wt;
      w += wt;
    }
  };
  mix(v00, (1 - tr) * (1 - tc));
  mix(v10, tr * (1 - tc));
  mix(v01, (1 - tr) * tc);
  mix(v11, tr * tc);
  return w > 0 ? sum / w : NaN;
}

/** 供测试断言：外弧样本不会污染内弧（返回内弧位置的插值与角度差） */
export function intradosContaminationCheck(
  _dom: FittingDomain,
  grid: FieldGrid,
  extradosTheta: number,
  intradosTheta: number,
  sMid: number,
): { value: number; angularGap: number } {
  return {
    value: lookupGrid(grid, sMid, intradosTheta),
    angularGap: angularDelta(extradosTheta, intradosTheta),
  };
}
