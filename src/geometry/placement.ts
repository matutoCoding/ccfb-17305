/**
 * 测点三维落点：管件编号定位域，轴向距离=弧长 s，钟点=周向角 θ。
 * 同一定义在建模、渲染、导出中只走这一个函数，保证数字一致。
 */
import { PointPlacement, ThicknessPoint } from '../types';
import { clockToTheta, v3, Vec3 } from '../math/vector';
import {
  FittingDomain,
  PipelineGeometry,
  classifyBendSide,
  placeOnSurface,
} from './centerline';

export interface PlacementResult {
  placements: PointPlacement[];
  placementByPoint: Map<string, PointPlacement>;
  /** 落点参数（域 id, s, θ），插值与着色器共用 */
  paramsByPoint: Map<string, { domainId: string; s: number; theta: number }>;
  errors: { point: ThicknessPoint; message: string }[];
}

export function placePoints(
  geo: PipelineGeometry,
  points: ThicknessPoint[],
): PlacementResult {
  const placements: PointPlacement[] = [];
  const placementByPoint = new Map<string, PointPlacement>();
  const paramsByPoint = new Map<string, { domainId: string; s: number; theta: number }>();
  const errors: { point: ThicknessPoint; message: string }[] = [];

  for (const p of points) {
    const dom = geo.domainByFitting.get(p.fittingId);
    if (!dom) {
      errors.push({ point: p, message: `点 ${p.pointNo} 所属管件不存在或未建模` });
      continue;
    }
    if (p.axialDistance < -1e-6 || p.axialDistance > dom.length + 1e-6) {
      errors.push({
        point: p,
        message: `点 ${p.pointNo} 轴向距离 ${p.axialDistance}mm 超出管件长度 ${dom.length.toFixed(1)}mm`,
      });
      continue;
    }
    if (!(p.clock >= 1 && p.clock <= 12)) {
      errors.push({ point: p, message: `点 ${p.pointNo} 钟点 ${p.clock} 超出 1~12 范围` });
      continue;
    }
    const s = Math.max(0, Math.min(dom.length, p.axialDistance));
    const theta = clockToTheta(p.clock);
    const { position, normal } = placeOnSurface(dom, s, theta);
    const computedSide = dom.kind === 'BEND' ? classifyBendSide(dom, normal) : 'NONE';

    // 录入的内/外弧标注与几何判定交叉校验
    if (dom.kind === 'BEND' && p.bendSide !== 'NONE' && p.bendSide !== computedSide) {
      errors.push({
        point: p,
        message: `点 ${p.pointNo} 标注 ${p.bendSide} 与几何判定 ${computedSide} 不符（钟点/流向基准请核对）`,
      });
    }

    const placement: PointPlacement = {
      pointId: p.id,
      position: [position[0], position[1], position[2]],
      normal: [normal[0], normal[1], normal[2]],
      domainId: dom.fittingId,
      s,
      theta,
      bendSide: computedSide,
    };
    placements.push(placement);
    placementByPoint.set(p.id, placement);
    paramsByPoint.set(p.id, { domainId: dom.fittingId, s, theta });
  }
  return { placements, placementByPoint, paramsByPoint, errors };
}

/**
 * 管壁表面度量（禁止穿过管心）：
 *   d² = ds² + (R·dθ)²，θ 差按圆周最短角处理。
 * 弯头的 R 取该点实际外半径（外弧 R+r、内弧 R-r 由 s/θ 几何自然体现），
 * 同域两点、域边界两侧不参与同一插值。
 */
export function surfaceMetric(
  dom: FittingDomain,
  a: { s: number; theta: number },
  b: { s: number; theta: number },
): number {
  let dTheta = Math.abs(a.theta - b.theta);
  dTheta = Math.min(dTheta, 2 * Math.PI - dTheta);
  const rA = surfaceRadiusAt(dom, a.s);
  const rB = surfaceRadiusAt(dom, b.s);
  const r = (rA + rB) / 2;
  const ds = a.s - b.s;
  return Math.sqrt(ds * ds + (r * dTheta) * (r * dTheta));
}

function surfaceRadiusAt(dom: FittingDomain, s: number): number {
  const t = dom.length < 1e-9 ? 0 : Math.max(0, Math.min(1, s / dom.length));
  const outR = (dom.outletDiameter ?? dom.diameter) / 2;
  return dom.diameter / 2 + (outR - dom.diameter / 2) * t;
}

/** 任意世界点到某测点的直线距离（拾取高亮用，非插值用） */
export function worldDistance(a: Vec3, b: Vec3): number {
  return v3.dist(a, b);
}
