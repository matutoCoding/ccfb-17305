/**
 * API 570 思路的寿命评估（纯函数，三维拾取与导出表共用同一份结果）。
 *
 * 最小要求壁厚：
 *   直管 tmin = P·D / (2·(S·E + P·Y)) + CA        （ASME B31.3 内压公式，Y=0.4）
 *   弯头乘以应力增强系数 I = 1.25（可配置），即 tmin_elbow = I · tmin_straight
 * 腐蚀速率（mm/a）：
 *   长期 = (t0 - tn) / (date_n - date0) 年
 *   短期 = (t(n-1) - tn) / 相邻期年差
 *   剩余寿命 RL = (当前最小实测厚度 - tmin) / max(长期, 短期)
 * 下次检验日期 = min(RL/2, 上限 10 年)，且不晚于 RL 耗尽日。
 */
import { Fitting, InspectionRound, Pipeline, ThicknessPoint } from '../types';
import { allowableStressAt } from '../standards';
import { FieldGrid } from './field';

export const DAY_MS = 86_400_000;
export const YEAR_MS = 365.25 * DAY_MS;
export const Y_FACTOR = 0.4;
export const ELBOW_STRESS_FACTOR = 1.25;
export const MAX_INTERVAL_YEARS = 10;

export interface PointStat {
  pointId: string;
  pointNo: string;
  fittingId: string;
  bendSide: 'INTRADOS' | 'EXTRADOS' | 'SIDE' | 'NONE';
  readings: { roundId: string; date: number; thickness: number; suspicious: boolean }[];
  latestThickness: number;
  minThickness: number;
  longTermRate: number; // mm/a，正值=减薄
  shortTermRate: number;
  governingRate: number;
  tMin: number;
  remainingLifeYears: number; // Infinity 表示无减薄
  nextInspectionDate: number | null;
  suspicious: boolean; // 最新一期存在增厚超差
}

export interface FittingStat {
  fittingId: string;
  tag: string;
  kind: string;
  tMin: number;
  minThickness: number; // 当前期全场最小（含 C 扫描网格）
  minPointNo: string;
  minLocation: { s: number; theta: number } | null;
  longTermRate: number;
  shortTermRate: number;
  governingRate: number;
  remainingLifeYears: number;
  nextInspectionDate: number | null;
  worstPointId: string | null;
  erosionFocus: boolean;
  pointCount: number;
  extradosPointCount: number;
}

export interface PipelineAssessment {
  pipelineId: string;
  calculatedAt: number;
  allowableStress: number;
  pointStats: PointStat[];
  fittingStats: FittingStat[];
  worstFitting: FittingStat | null;
}

export interface AssessmentInput {
  pipeline: Pipeline;
  fittings: Fitting[];
  points: ThicknessPoint[];
  rounds: InspectionRound[];
  /** pointId -> roundId -> 厚度；可疑标记在外层给出 */
  readings: Map<string, Map<string, { thickness: number; suspicious: boolean }>>;
  /** 每个域最新一期的云图网格（C 扫描参与全场最小值） */
  latestGrids: Map<string, FieldGrid>;
  /** 最新一期 roundId */
  latestRoundId: string;
  now: number;
}

export function pressureThicknessStraight(p: Pipeline, sAllowable: number): number {
  const D = p.outerDiameter;
  const P = Math.max(p.designPressure, 0.001);
  const E = p.weldJointEfficiency || 1;
  return (P * D) / (2 * (sAllowable * E + P * Y_FACTOR));
}

export function minRequiredThickness(
  p: Pipeline,
  fitting: Fitting,
  sAllowable: number,
): number {
  const tPress = pressureThicknessStraight(p, sAllowable);
  const factor = fitting.kind === 'ELBOW' ? ELBOW_STRESS_FACTOR : 1;
  return tPress * factor + p.corrosionAllowance;
}

function yearsBetween(a: number, b: number): number {
  return Math.abs(b - a) / YEAR_MS;
}

export function assess(input: AssessmentInput): PipelineAssessment {
  const { pipeline, fittings, points, rounds, readings, latestGrids, latestRoundId, now } = input;
  const sAllow = allowableStressAt(pipeline.material, pipeline.designTemp);
  const sortedRounds = [...rounds].sort((a, b) => a.inspectDate - b.inspectDate);
  const fittingById = new Map(fittings.map((f) => [f.id, f]));

  const pointStats: PointStat[] = [];
  for (const pt of points) {
    const fit = fittingById.get(pt.fittingId);
    if (!fit) continue;
    const tMin = minRequiredThickness(pipeline, fit, sAllow);
    const series = readings.get(pt.id);
    const list: PointStat['readings'] = [];
    if (series) {
      for (const r of sortedRounds) {
        const v = series.get(r.id);
        if (v) list.push({ roundId: r.id, date: r.inspectDate, thickness: v.thickness, suspicious: v.suspicious });
      }
    }
    list.sort((a, b) => a.date - b.date);
    const latest = list.length ? list[list.length - 1].thickness : NaN;
    const minT = list.length ? Math.min(...list.map((x) => x.thickness)) : NaN;

    let longTerm = 0;
    let shortTerm = 0;
    if (list.length >= 2) {
      const valid = list.filter((x) => !x.suspicious);
      if (valid.length >= 2) {
        const first = valid[0];
        const last = valid[valid.length - 1];
        const yLong = yearsBetween(first.date, last.date);
        if (yLong > 0.01) longTerm = Math.max(0, (first.thickness - last.thickness) / yLong);
        if (valid.length >= 2) {
          const prev = valid[valid.length - 2];
          const yShort = yearsBetween(prev.date, last.date);
          if (yShort > 0.01) shortTerm = Math.max(0, (prev.thickness - last.thickness) / yShort);
        }
      }
    }
    const governing = Math.max(longTerm, shortTerm);
    const rl = !Number.isFinite(minT) ? Infinity
      : governing <= 1e-9 ? Infinity
      : Math.max(0, (latest - tMin) / governing);
    const nextDate = computeNextDate(rl, now, latest);
    const suspicious = list.some((x) => x.suspicious && x.roundId === latestRoundId);

    pointStats.push({
      pointId: pt.id,
      pointNo: pt.pointNo,
      fittingId: pt.fittingId,
      bendSide: pt.bendSide,
      readings: list,
      latestThickness: latest,
      minThickness: minT,
      longTermRate: round4(longTerm),
      shortTermRate: round4(shortTerm),
      governingRate: round4(governing),
      tMin: round3(tMin),
      remainingLifeYears: Number.isFinite(rl) ? round2(rl) : Infinity,
      nextInspectionDate: nextDate,
      suspicious,
    });
  }

  // 管件级聚合
  const fittingStats: FittingStat[] = [];
  const statsByFitting = new Map<string, PointStat[]>();
  for (const st of pointStats) {
    if (!statsByFitting.has(st.fittingId)) statsByFitting.set(st.fittingId, []);
    statsByFitting.get(st.fittingId)!.push(st);
  }

  for (const fit of fittings) {
    const tMin = minRequiredThickness(pipeline, fit, sAllow);
    const pstats = statsByFitting.get(fit.id) ?? [];
    let minThickness = NaN;
    let minPointNo = '';
    let worstPointId: string | null = null;
    let minLocation: { s: number; theta: number } | null = null;

    for (const st of pstats) {
      if (Number.isFinite(st.latestThickness) && (!Number.isFinite(minThickness) || st.latestThickness < minThickness)) {
        minThickness = st.latestThickness;
        minPointNo = st.pointNo;
        worstPointId = st.pointId;
      }
    }
    // C 扫描/云图全场最小（可能落在网格而非 TML 上）
    const grid = latestGrids.get(fit.id);
    if (grid && grid.hasData) {
      for (let i = 0; i < grid.values.length; i++) {
        const v = grid.values[i];
        if (Number.isFinite(v) && (!Number.isFinite(minThickness) || v < minThickness)) {
          minThickness = v;
          const row = Math.floor(i / grid.cols);
          const col = i % grid.cols;
          minPointNo = `${fit.tag}-C扫描`;
          minLocation = {
            s: ((row + 0.5) / grid.rows) * grid.sMax,
            theta: (col / grid.cols) * Math.PI * 2,
          };
          worstPointId = null;
        }
      }
    }

    const rates = pstats.filter((s) => Number.isFinite(s.latestThickness));
    const longTerm = rates.length ? Math.max(0, ...rates.map((s) => s.longTermRate)) : 0;
    const shortTerm = rates.length ? Math.max(0, ...rates.map((s) => s.shortTermRate)) : 0;
    const governing = Math.max(longTerm, shortTerm);
    const rl = !Number.isFinite(minThickness) ? Infinity
      : governing <= 1e-9 ? Infinity
      : Math.max(0, (minThickness - tMin) / governing);

    fittingStats.push({
      fittingId: fit.id,
      tag: fit.tag,
      kind: fit.kind,
      tMin: round3(tMin),
      minThickness: Number.isFinite(minThickness) ? round3(minThickness) : NaN,
      minPointNo,
      minLocation,
      longTermRate: round4(longTerm),
      shortTermRate: round4(shortTerm),
      governingRate: round4(governing),
      remainingLifeYears: Number.isFinite(rl) ? round2(rl) : Infinity,
      nextInspectionDate: computeNextDate(rl, now, minThickness),
      worstPointId,
      erosionFocus: !!fit.erosionFocus
        || (pipeline.injectionDownstreamTags ?? []).includes(fit.tag),
      pointCount: pstats.length,
      extradosPointCount: pstats.filter((s) => s.bendSide === 'EXTRADOS').length,
    });
  }

  const finite = fittingStats.filter((f) => Number.isFinite(f.remainingLifeYears));
  const worstFitting = finite.sort((a, b) => a.remainingLifeYears - b.remainingLifeYears)[0] ?? null;

  return {
    pipelineId: pipeline.id,
    calculatedAt: now,
    allowableStress: round2(sAllow),
    pointStats,
    fittingStats,
    worstFitting,
  };
}

function computeNextDate(rlYears: number, now: number, _latest: number): number | null {
  if (!Number.isFinite(rlYears)) return null;
  const interval = Math.min(rlYears / 2, MAX_INTERVAL_YEARS);
  return now + interval * YEAR_MS;
}

function round2(x: number): number { return Math.round(x * 100) / 100; }
function round3(x: number): number { return Math.round(x * 1000) / 1000; }
function round4(x: number): number { return Math.round(x * 10000) / 10000; }
