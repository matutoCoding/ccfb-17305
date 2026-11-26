/**
 * 检验计划：
 *  - 剩余寿命 < 2 个检验周期的管件直接列入；
 *  - 冲刷重点（弯头外弧、三通、盲端、注水点下游）检查测点覆盖，
 *    外弧无点/点数不足的自动给建议加点，建议点直接给三维参数 (domainId, s, θ)；
 *  - 导出测厚任务单（含等轴测截图位与点位编号）。
 */
import { Fitting, ThicknessPoint } from '../types';
import { FittingDomain, sampleDomain } from '../geometry/centerline';
import { normalToTheta, sectionFrame, v3 } from '../math/vector';
import { FittingStat } from './life';

export interface SuggestedPoint {
  fittingId: string;
  tag: string;
  pointNo: string;
  s: number;
  theta: number;
  clock: number;
  bendSide: 'INTRADOS' | 'EXTRADOS' | 'SIDE' | 'NONE';
  reason: string;
}

export interface InspectionItem {
  fittingId: string;
  tag: string;
  kind: string;
  reasons: string[];
  riskLevel: 'HIGH' | 'MEDIUM';
  remainingLifeYears: number;
  nextInspectionDate: number | null;
  existingPointCount: number;
  extradosCovered: boolean;
  suggestedPoints: SuggestedPoint[];
}

export interface InspectionPlan {
  generatedAt: number;
  inspectionCycleYears: number;
  items: InspectionItem[];
}

/** θ(12点=0, 顺时针) -> 钟点 */
function thetaToClock(theta: number): number {
  const t = ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const c = (t / (2 * Math.PI)) * 12;
  return c < 1e-9 ? 12 : c;
}

/** 弯头域内 s 处外弧法线对应的 θ（径向向量在该截面基下反算） */
function extradosThetaAt(dom: FittingDomain, s: number): number {
  const b = dom.bend!;
  const phi = s / b.radius;
  const radial = v3.rotateAroundAxis(b.radialIn, b.axis, phi);
  const { tangent } = sampleDomain(dom, s);
  const { side, up } = sectionFrame(tangent);
  return normalToTheta(side, up, radial);
}

export function buildInspectionPlan(
  fittings: Fitting[],
  domains: FittingDomain[],
  points: ThicknessPoint[],
  stats: FittingStat[],
  now: number,
  inspectionCycleYears = 5,
): InspectionPlan {
  const domById = new Map(domains.map((d) => [d.fittingId, d]));
  const statById = new Map(stats.map((s) => [s.fittingId, s]));
  const pointsByFitting = new Map<string, ThicknessPoint[]>();
  for (const p of points) {
    if (!pointsByFitting.has(p.fittingId)) pointsByFitting.set(p.fittingId, []);
    pointsByFitting.get(p.fittingId)!.push(p);
  }

  const items: InspectionItem[] = [];
  for (const fit of fittings) {
    const dom = domById.get(fit.id);
    const stat = statById.get(fit.id);
    if (!dom || !stat) continue;
    const local = pointsByFitting.get(fit.id) ?? [];
    const reasons: string[] = [];
    let high = false;

    // 规则 1：剩余寿命 < 2 个检验周期
    const rl = stat.remainingLifeYears;
    if (Number.isFinite(rl) && rl < 2 * inspectionCycleYears) {
      reasons.push(`剩余寿命 ${rl} 年 < 2 个检验周期(${2 * inspectionCycleYears} 年)`);
      high = true;
    }
    const isErosion = stat.erosionFocus || fit.kind === 'ELBOW' || fit.kind === 'TEE';
    if (isErosion && local.length === 0) {
      reasons.push('冲刷重点管件无任何测厚点');
      high = true;
    }

    // 规则 2：弯头外弧覆盖
    const extradosPts = local.filter((p) => p.bendSide === 'EXTRADOS');
    const suggested: SuggestedPoint[] = [];
    if (fit.kind === 'ELBOW' && dom.kind === 'BEND' && dom.bend) {
      if (extradosPts.length === 0) {
        reasons.push('弯头外弧无测点（冲刷减薄盲区）');
        const stations: [number, string][] = [
          [0.25, 'EX2'],
          [0.5, 'EX1'],
          [0.75, 'EX3'],
        ];
        for (const [q, suffix] of stations) {
          const s = dom.length * q;
          const th = extradosThetaAt(dom, s);
          suggested.push({
            fittingId: fit.id, tag: fit.tag,
            pointNo: `${fit.tag}-T-${suffix}`,
            s: round1(s), theta: th,
            clock: round2(thetaToClock(th)),
            bendSide: 'EXTRADOS',
            reason: q === 0.5
              ? '弯头外弧冲刷重点，建议在弧长中点外弧处增设'
              : '外弧轴向加密，覆盖局部冲刷坑',
          });
        }
      } else if (extradosPts.length < 3) {
        reasons.push(`弯头外弧仅 ${extradosPts.length} 个测点，覆盖不足`);
        const sMid = dom.length / 2;
        const hasMid = extradosPts.some((p) => Math.abs(p.axialDistance - sMid) < dom.length * 0.2);
        if (!hasMid) {
          const th = extradosThetaAt(dom, sMid);
          suggested.push({
            fittingId: fit.id, tag: fit.tag,
            pointNo: `${fit.tag}-T-EXM`,
            s: round1(sMid), theta: th,
            clock: round2(thetaToClock(th)),
            bendSide: 'EXTRADOS',
            reason: '外弧中点缺测点',
          });
        }
      }
    }

    // 规则 3：三通肩部
    if (fit.kind === 'TEE') {
      const shoulder = local.filter((p) => p.clock === 3 || p.clock === 9);
      if (shoulder.length < 2) {
        reasons.push('三通肩部/盲端方向测点不足');
        for (const clock of [3, 9] as const) {
          suggested.push({
            fittingId: fit.id, tag: fit.tag,
            pointNo: `${fit.tag}-T-S${clock}`,
            s: round1(dom.length / 2),
            theta: (clock / 12) * Math.PI * 2,
            clock,
            bendSide: 'SIDE',
            reason: '三通肩部冲刷测点',
          });
        }
      }
    }

    // 规则 4：注水点下游直管
    if (stat.erosionFocus && fit.kind === 'PIPE') {
      const zones = [0.25, 0.5, 0.75].map((q) => dom.length * q);
      const covered = zones.filter((z) =>
        local.some((p) => Math.abs(p.axialDistance - z) < dom.length * 0.15));
      if (covered.length < zones.length) {
        reasons.push('注水点下游冲刷段测点覆盖不足');
        for (let i = 0; i < zones.length; i++) {
          if (!covered.includes(zones[i])) {
            suggested.push({
              fittingId: fit.id, tag: fit.tag,
              pointNo: `${fit.tag}-T-W${i + 1}`,
              s: round1(zones[i]), theta: 0, clock: 12,
              bendSide: 'NONE',
              reason: '注水点下游冲刷轴向布点（12 点）',
            });
          }
        }
      }
    }

    if (reasons.length === 0) continue;
    items.push({
      fittingId: fit.id,
      tag: fit.tag,
      kind: fit.kind,
      reasons,
      riskLevel: high ? 'HIGH' : 'MEDIUM',
      remainingLifeYears: rl,
      nextInspectionDate: stat.nextInspectionDate,
      existingPointCount: local.length,
      extradosCovered: extradosPts.length > 0,
      suggestedPoints: suggested,
    });
  }

  items.sort((a, b) => {
    if (a.riskLevel !== b.riskLevel) return a.riskLevel === 'HIGH' ? -1 : 1;
    const ra = Number.isFinite(a.remainingLifeYears) ? a.remainingLifeYears : 9999;
    const rb = Number.isFinite(b.remainingLifeYears) ? b.remainingLifeYears : 9999;
    return ra - rb;
  });

  return { generatedAt: now, inspectionCycleYears, items };
}

function round1(x: number): number { return Math.round(x * 10) / 10; }
function round2(x: number): number { return Math.round(x * 100) / 100; }
