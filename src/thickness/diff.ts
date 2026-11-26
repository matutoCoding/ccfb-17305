/**
 * 两期对比：差值云图与可疑点判定。
 * 后一期比前一期"厚"出测量误差的点标记 suspicious，不参与速率计算。
 */
import { DEFAULT_MEASUREMENT_ERROR_MM } from '../standards';
import { FieldGrid, ThicknessField } from './field';

export interface DiffPoint {
  pointNo: string;
  domainId: string;
  s: number;
  theta: number;
  prevThickness: number;
  nextThickness: number;
  delta: number; // 后 - 前，负=减薄
  suspicious: boolean;
}

export interface DiffResult {
  prevRoundId: string;
  nextRoundId: string;
  pointDiffs: DiffPoint[];
  /** 差值场网格（每个域一张），NaN=缺数据 */
  diffGrids: Map<string, FieldGrid>;
  suspiciousCount: number;
}

export function diffRounds(
  prev: { roundId: string; field: ThicknessField },
  next: { roundId: string; field: ThicknessField },
  measurementError = DEFAULT_MEASUREMENT_ERROR_MM,
): DiffResult {
  const pointDiffs: DiffPoint[] = [];
  const prevByKey = new Map(prev.field.samples.map((s) => [`${s.domainId}|${s.s.toFixed(3)}|${s.theta.toFixed(5)}`, s]));
  for (const sp of next.field.samples) {
    const key = `${sp.domainId}|${sp.s.toFixed(3)}|${sp.theta.toFixed(5)}`;
    const old = prevByKey.get(key);
    if (!old) continue;
    const delta = sp.thickness - old.thickness;
    pointDiffs.push({
      pointNo: sp.pointNo ?? '',
      domainId: sp.domainId,
      s: sp.s,
      theta: sp.theta,
      prevThickness: old.thickness,
      nextThickness: sp.thickness,
      delta: round3(delta),
      suspicious: delta > measurementError,
    });
  }

  const diffGrids = new Map<string, FieldGrid>();
  const domainIds = new Set<string>([
    ...prev.field.grids.keys(),
    ...next.field.grids.keys(),
  ]);
  for (const id of domainIds) {
    const g0 = prev.field.grids.get(id);
    const g1 = next.field.grids.get(id);
    if (!g0 || !g1) continue;
    const rows = Math.max(g0.rows, g1.rows);
    const cols = Math.max(g0.cols, g1.cols);
    const vals = new Float32Array(rows * cols).fill(NaN);
    const dist = new Float32Array(rows * cols).fill(NaN);
    for (let i = 0; i < g0.values.length && i < g1.values.length; i++) {
      const a = g0.values[i];
      const b = g1.values[i];
      if (Number.isFinite(a) && Number.isFinite(b)) vals[i] = round3(b - a);
    }
    diffGrids.set(id, {
      domainId: id, rows, cols,
      sMin: g1.sMin, sMax: g1.sMax,
      values: vals, nearestDist: dist, hasData: true,
    });
  }

  return {
    prevRoundId: prev.roundId,
    nextRoundId: next.roundId,
    pointDiffs,
    diffGrids,
    suspiciousCount: pointDiffs.filter((d) => d.suspicious).length,
  };
}

function round3(x: number): number { return Math.round(x * 1000) / 1000; }
