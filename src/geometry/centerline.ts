/**
 * 中心线建模：把逐段录入的管件扫成三维走向。
 *
 * 关键约定：
 * - 每个管件是一个独立的参数域 [0, L]（弯头 L=R·α 为中心线弧长），
 *   域与域之间即焊口/法兰，壁厚插值禁止跨域。
 * - 弯头入口方向 dIn、出口方向 dOut 必须垂直（90°）或夹 45°，
 *   弯曲平面由二者叉积确定，弯管中心 C = P + R·(dOut-dIn)/(1-cosα)。
 * - 钟点基准由流向与正上方（世界 +Y）按 sectionFrame 定死，可复算。
 */
import {
  DIR_VECTORS,
  Direction,
  Fitting,
  ModelingIssue,
  Pipeline,
} from '../types';
import { Vec3, v3, sectionFrame } from '../math/vector';

export type DomainKind = 'STRAIGHT' | 'BEND' | 'BRANCH_JUNCTION';

export interface CenterlineNode {
  s: number; // 中心线弧长 mm
  point: Vec3;
  tangent: Vec3; // 该点流向单位向量
}

export interface FittingDomain {
  fittingId: string;
  routeId: string;
  kind: DomainKind;
  diameter: number; // 外径 mm
  nominalWall: number;
  length: number; // 域参数长度 mm（弧长）
  start: Vec3; // 入口焊口中心
  end: Vec3; // 出口焊口中心
  dIn: Vec3;
  dOut: Vec3;
  // 弯头专用
  bend?: {
    radius: number;
    angleRad: number;
    center: Vec3;
    axis: Vec3; // 弯曲轴单位向量（dIn × dOut 归一）
    radialIn: Vec3; // 入口处由中心指向管壁的径向单位向量
    radialOut: Vec3;
    extradosNormal: Vec3; // 外弧中点外法线
    intradosNormal: Vec3;
  };
  // 大小头
  outletDiameter?: number;
  reducerEccentric?: number;
  centerline: CenterlineNode[]; // 渲染/拾取采样折线
}

export interface TeeJunction {
  teeFittingId: string;
  branchRouteId: string;
  point: Vec3; // 支管开孔中心
  branchDir: Vec3;
  mainDIn: Vec3;
  mainDOut: Vec3;
  diameter: number;
}

export interface PipelineGeometry {
  pipelineId: string;
  domains: FittingDomain[]; // 按 route + seq 排序
  domainByFitting: Map<string, FittingDomain>;
  junctions: TeeJunction[];
  routes: { routeId: string; fittingIds: string[]; totalLength: number }[];
  mainTotalLength: number;
  issues: ModelingIssue[];
}

const EPS = 1e-6;

function dirOf(f: Fitting): Vec3 {
  return [...DIR_VECTORS[f.direction]] as Vec3;
}
function dirVec(d: Direction): Vec3 {
  return [...DIR_VECTORS[d]] as Vec3;
}

function elbowRadius(f: Fitting, fallbackDn: number): number {
  if (f.elbowRadiusType === 'CUSTOM' && f.bendRadius) return f.bendRadius;
  const dn = f.nominalDiameter ?? fallbackDn;
  return f.elbowRadiusType === 'SR' ? 1.0 * dn : 1.5 * dn;
}

/** 沿中心线在域内 s 处取点（s 为弧长，0=入口） */
export function sampleDomain(dom: FittingDomain, s: number): { point: Vec3; tangent: Vec3 } {
  const clamped = Math.max(0, Math.min(dom.length, s));
  if (dom.kind === 'BEND' && dom.bend) {
    const b = dom.bend;
    const phi = clamped / b.radius; // 绕轴转角
    // radial(phi)：入口径向绕 axis 转 phi（axis=dIn×dOut，旋转方向由 dIn→dOut）
    const radial = v3.rotateAroundAxis(b.radialIn, b.axis, phi);
    const point = v3.add(b.center, v3.scale(radial, b.radius));
    // tangent = axis × radial（验证：phi=0 时 = dIn）
    const tangent = v3.norm(v3.cross(b.axis, radial));
    return { point, tangent };
  }
  const t = dom.length < EPS ? 0 : clamped / dom.length;
  return {
    point: v3.lerp(dom.start, dom.end, t),
    tangent: v3.norm(dom.dIn),
  };
}

/**
 * 构建一条管线的全部域。
 * @param fittings 已按 seq 排序的管件（含主路与支管，routeId 区分）
 */
export function buildGeometry(pipeline: Pipeline, fittings: Fitting[]): PipelineGeometry {
  const issues: ModelingIssue[] = [];
  const tagSeen = new Map<string, string>();
  for (const f of fittings) {
    if (tagSeen.has(f.tag)) {
      issues.push({
        fittingId: f.id, seq: f.seq, level: 'ERROR', code: 'TAG_DUPLICATE',
        message: `管件编号 ${f.tag} 与 ${tagSeen.get(f.tag)} 重复`,
      });
    }
    tagSeen.set(f.tag, f.id);
  }

  // 路由分组
  const routes = new Map<string, Fitting[]>();
  for (const f of fittings) {
    const rid = f.routeId ?? 'main';
    if (!routes.has(rid)) routes.set(rid, []);
    routes.get(rid)!.push(f);
  }
  for (const list of routes.values()) list.sort((a, b) => a.seq - b.seq);

  const domains: FittingDomain[] = [];
  const domainByFitting = new Map<string, FittingDomain>();
  const junctions: TeeJunction[] = [];
  const routeInfo: PipelineGeometry['routes'] = [];

  const diameterOf = (f: Fitting) => f.diameter ?? pipeline.outerDiameter;
  const wallOf = (f: Fitting) => f.nominalWall ?? pipeline.nominalWall;

  function pushDomain(dom: FittingDomain) {
    domains.push(dom);
    domainByFitting.set(dom.fittingId, dom);
  }

  function makeStraight(
    f: Fitting, start: Vec3, dIn: Vec3, dOut: Vec3,
  ): FittingDomain {
    const end = v3.add(start, v3.scale(dOut, f.length));
    const dom: FittingDomain = {
      fittingId: f.id,
      routeId: f.routeId ?? 'main',
      kind: f.kind === 'ELBOW' ? 'BEND' : 'STRAIGHT',
      diameter: diameterOf(f),
      nominalWall: wallOf(f),
      length: f.length,
      start: [...start] as Vec3,
      end: [...end] as Vec3,
      dIn: [...dIn] as Vec3,
      dOut: [...dOut] as Vec3,
      outletDiameter: f.kind === 'REDUCER' ? f.outletDiameter : undefined,
      reducerEccentric: f.kind === 'REDUCER' ? f.eccentricOffset ?? 0 : undefined,
      centerline: [],
    };
    return dom;
  }

  function makeBend(f: Fitting, start: Vec3, dIn: Vec3, dOut: Vec3): FittingDomain {
    const dn = diameterOf(f);
    const R = elbowRadius(f, pipeline.nominalDiameter);
    const alpha = Math.acos(Math.max(-1, Math.min(1, v3.dot(dIn, dOut))));
    const axis = v3.norm(v3.cross(dIn, dOut));
    // 验证旋转方向：dOut 应等于 dIn 绕 axis 转 alpha
    const check = v3.rotateAroundAxis(dIn, axis, alpha);
    if (v3.dist(check, dOut) > 1e-5) {
      throw new Error(`弯头 ${f.tag} 弯曲轴方向校验失败`);
    }
    const radialIn = v3.norm(v3.cross(dIn, axis)); // 满足 axis × radialIn = dIn
    // 圆心 C = P - R·radialIn
    const center = v3.add(start, v3.scale(radialIn, -R));
    // 校验：axis × radialIn 必须等于 dIn
    const tangentCheck = v3.cross(axis, radialIn);
    if (v3.dist(tangentCheck, dIn) > 1e-5) {
      throw new Error(`弯头 ${f.tag} 入口径向校验失败`);
    }
    const radialOut = v3.rotateAroundAxis(radialIn, axis, alpha);
    const end = v3.add(center, v3.scale(radialOut, R));
    const midPhi = alpha / 2;
    const radialMid = v3.rotateAroundAxis(radialIn, axis, midPhi);
    const arcLen = R * alpha;
    const dom: FittingDomain = {
      fittingId: f.id,
      routeId: f.routeId ?? 'main',
      kind: 'BEND',
      diameter: dn,
      nominalWall: wallOf(f),
      length: arcLen,
      start: [...start] as Vec3,
      end: [...end] as Vec3,
      dIn: [...dIn] as Vec3,
      dOut: [...dOut] as Vec3,
      bend: {
        radius: R,
        angleRad: alpha,
        center,
        axis,
        radialIn,
        radialOut,
        extradosNormal: radialMid, // 外弧中点：背离弯心
        intradosNormal: v3.neg(radialMid),
      },
      centerline: [],
    };
    return dom;
  }

  /** 先建主路，同时登记三通 junction，再建支管 */
  const mainList = routes.get('main') ?? [];
  const branchStart = new Map<string, { point: Vec3; dir: Vec3; tee: Fitting }>();

  let cursor: Vec3 = [0, 0, 0];
  let prevOut: Vec3 | null = null;
  let mainLength = 0;

  for (let i = 0; i < mainList.length; i++) {
    const f = mainList[i];
    const dIn = dirOf(f);
    // 走向接不上：本段入口方向与上段出口不一致
    if (prevOut && v3.dist(prevOut, dIn) > EPS) {
      issues.push({
        fittingId: f.id, seq: f.seq, level: 'ERROR', code: 'DIRECTION_MISMATCH',
        message: `管件 ${f.tag} 入口方向 ${f.direction} 与上一段出口走向不一致，走向接不上`,
      });
    }
    let dom: FittingDomain;
    if (f.kind === 'ELBOW') {
      const next = mainList[i + 1];
      let dOutVec: Vec3;
      if (f.exitDirection) {
        dOutVec = dirVec(f.exitDirection);
      } else if (next && next.routeId !== 'main') {
        dOutVec = dirVec(next.direction);
      } else if (next) {
        dOutVec = dirVec(next.direction);
      } else {
        issues.push({
          fittingId: f.id, seq: f.seq, level: 'ERROR', code: 'DIRECTION_MISMATCH',
          message: `末端弯头 ${f.tag} 缺少出口方向(exitDirection)，无法确定弯曲平面`,
        });
        dOutVec = dIn;
      }
      const cosA = v3.dot(dIn, dOutVec);
      const alphaDeg = f.elbowAngle ?? 90;
      const expected = Math.cos((alphaDeg * Math.PI) / 180);
      if (Math.abs(cosA - expected) > 1e-4 && Math.abs(cosA - 1) > 1e-4) {
        issues.push({
          fittingId: f.id, seq: f.seq, level: 'ERROR', code: 'UNSUPPORTED_BEND_PLANE',
          message: `弯头 ${f.tag} 入/出口夹角 ${(Math.acos(Math.max(-1, Math.min(1, cosA))) * 180 / Math.PI).toFixed(1)}° 与标称 ${alphaDeg}° 不符`,
        });
      }
      dom = makeBend(f, cursor, dIn, dOutVec);
      prevOut = dom.dOut;
    } else if (f.kind === 'TEE') {
      // 直通本体按直管处理，支管开孔登记
      dom = makeStraight(f, cursor, dIn, dIn);
      if (!f.branchDirection) {
        issues.push({
          fittingId: f.id, seq: f.seq, level: 'ERROR', code: 'REDUCER_PARAM_MISSING',
          message: `三通 ${f.tag} 未指定支管方向 branchDirection`,
        });
      } else {
        const off = f.branchOffset ?? f.length / 2;
        const jPoint = v3.add(cursor, v3.scale(dIn, off));
        const bDir = dirVec(f.branchDirection);
        junctions.push({
          teeFittingId: f.id,
          branchRouteId: f.id,
          point: jPoint,
          branchDir: bDir,
          mainDIn: dIn,
          mainDOut: dIn,
          diameter: diameterOf(f),
        });
        branchStart.set(f.id, { point: jPoint, dir: bDir, tee: f });
      }
      prevOut = dIn;
    } else {
      if (f.kind === 'REDUCER' && !f.outletDiameter) {
        issues.push({
          fittingId: f.id, seq: f.seq, level: 'WARN', code: 'REDUCER_PARAM_MISSING',
          message: `大小头 ${f.tag} 未填出口外径 outletDiameter`,
        });
      }
      dom = makeStraight(f, cursor, dIn, dIn);
      prevOut = dIn;
    }
    // 中心线采样
    const steps = Math.max(2, Math.ceil(dom.length / Math.max(50, dom.diameter / 2)));
    dom.centerline = Array.from({ length: steps + 1 }, (_, k) => {
      const s = (dom.length * k) / steps;
      const n = sampleDomain(dom, s);
      return { s, point: n.point, tangent: n.tangent };
    });
    pushDomain(dom);
    mainLength += dom.length;
    cursor = dom.end;
  }

  routeInfo.push({
    routeId: 'main',
    fittingIds: mainList.map((f) => f.id),
    totalLength: round1(mainLength),
  });

  // 支管路由
  for (const [rid, list] of routes) {
    if (rid === 'main') continue;
    const startInfo = branchStart.get(rid);
    if (!startInfo) {
      for (const f of list) {
        issues.push({
          fittingId: f.id, seq: f.seq, level: 'ERROR', code: 'DIRECTION_MISMATCH',
          message: `支管路由 ${rid} 找不到对应的三通开孔`,
        });
      }
      continue;
    }
    let bCursor = startInfo.point;
    let bPrev: Vec3 | null = null;
    let bLen = 0;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const dIn = dirOf(f);
      if (bPrev && v3.dist(bPrev, dIn) > EPS) {
        issues.push({
          fittingId: f.id, seq: f.seq, level: 'ERROR', code: 'DIRECTION_MISMATCH',
          message: `支管管件 ${f.tag} 走向与上一段接不上`,
        });
      } else if (!bPrev && v3.dist(dIn, startInfo.dir) > EPS) {
        issues.push({
          fittingId: f.id, seq: f.seq, level: 'WARN', code: 'DIRECTION_MISMATCH',
          message: `支管首段 ${f.tag} 方向与三通支管方向不一致，已按三通方向校正`,
        });
      }
      const useDIn = bPrev ?? startInfo.dir;
      let dom: FittingDomain;
      if (f.kind === 'ELBOW') {
        const next = list[i + 1];
        const dOutVec = f.exitDirection ? dirVec(f.exitDirection)
          : next ? dirVec(next.direction) : useDIn;
        dom = makeBend(f, bCursor, useDIn, dOutVec);
      } else if (f.kind === 'TEE') {
        dom = makeStraight(f, bCursor, useDIn, useDIn);
        if (f.branchDirection) {
          const off = f.branchOffset ?? f.length / 2;
          const jPoint = v3.add(bCursor, v3.scale(useDIn, off));
          junctions.push({
            teeFittingId: f.id, branchRouteId: f.id, point: jPoint,
            branchDir: dirVec(f.branchDirection), mainDIn: useDIn, mainDOut: useDIn,
            diameter: diameterOf(f),
          });
          branchStart.set(f.id, { point: jPoint, dir: dirVec(f.branchDirection), tee: f });
        }
      } else {
        dom = makeStraight(f, bCursor, useDIn, useDIn);
      }
      const steps = Math.max(2, Math.ceil(dom.length / Math.max(50, dom.diameter / 2)));
      dom.centerline = Array.from({ length: steps + 1 }, (_, k) => {
        const s = (dom.length * k) / steps;
        const n = sampleDomain(dom, s);
        return { s, point: n.point, tangent: n.tangent };
      });
      pushDomain(dom);
      bLen += dom.length;
      bCursor = dom.end;
      bPrev = dom.dOut;
    }
    routeInfo.push({ routeId: rid, fittingIds: list.map((f) => f.id), totalLength: round1(bLen) });
  }

  // 总长核对
  if (pipeline.drawingTotalLength != null) {
    const diff = Math.abs(mainLength - pipeline.drawingTotalLength);
    if (diff > Math.max(5, pipeline.drawingTotalLength * 0.01)) {
      issues.push({
        fittingId: '', seq: -1, level: 'ERROR', code: 'LENGTH_MISMATCH',
        message: `主管建模总长 ${round1(mainLength)} mm 与图纸总长 ${pipeline.drawingTotalLength} mm 相差 ${round1(diff)} mm`,
      });
    }
  }

  return {
    pipelineId: pipeline.id,
    domains,
    domainByFitting,
    junctions,
    routes: routeInfo,
    mainTotalLength: round1(mainLength),
    issues,
  };
}

/** 弯头内弧/外弧判定（按 θ 与外弧法线夹角） */
export function classifyBendSide(
  dom: FittingDomain,
  normal: Vec3,
): 'INTRADOS' | 'EXTRADOS' | 'SIDE' {
  if (dom.kind !== 'BEND' || !dom.bend) return 'NONE' as never;
  const dotExtra = v3.dot(normal, dom.bend.extradosNormal);
  const dotIntra = v3.dot(normal, dom.bend.intradosNormal);
  const COS30 = Math.cos((30 * Math.PI) / 180); // ±30° 锥区
  if (dotExtra >= COS30) return 'EXTRADOS';
  if (dotIntra >= COS30) return 'INTRADOS';
  return 'SIDE';
}

/** 弯头域内 s 处外弧/内弧法线在该截面钟点基准下的 θ */
export function bendSideTheta(dom: FittingDomain, s: number, side: 'EXTRADOS' | 'INTRADOS'): number {
  if (dom.kind !== 'BEND' || !dom.bend) throw new Error('仅弯头域可求内外弧 θ');
  const b = dom.bend;
  const phi = Math.max(0, Math.min(b.angleRad, s / b.radius));
  const radial = v3.rotateAroundAxis(b.radialIn, b.axis, phi);
  const n = side === 'EXTRADOS' ? radial : v3.neg(radial);
  const { tangent } = sampleDomain(dom, s);
  const { side: secSide, up } = sectionFrame(tangent);
  const x = v3.dot(n, secSide);
  const y = v3.dot(n, up);
  return (Math.atan2(x, y) + 2 * Math.PI) % (2 * Math.PI);
}

/** 给定域 + 弧长 s + 钟点，求管壁外表面落点与外法线（测点定位的唯一入口） */
export function placeOnSurface(
  dom: FittingDomain,
  s: number,
  theta: number,
): { position: Vec3; normal: Vec3; tangent: Vec3 } {
  const { point, tangent } = sampleDomain(dom, s);
  const { side, up } = sectionFrame(tangent);
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);
  const normal: Vec3 = v3.norm([
    up[0] * cos + side[0] * sin,
    up[1] * cos + side[1] * sin,
    up[2] * cos + side[2] * sin,
  ]);
  // 偏心大小头：中心线在偏心方向平移（按 s 线性）
  let center = point;
  if (dom.reducerEccentric) {
    const t = dom.length < EPS ? 0 : s / dom.length;
    center = v3.add(point, v3.scale(up, dom.reducerEccentric * (1 - t)));
  }
  const radius = surfaceRadius(dom, s);
  const position = v3.add(center, v3.scale(normal, radius));
  return { position, normal, tangent };
}

/** 域内 s 处的外半径（大小头线性变径，其余恒定） */
export function surfaceRadius(dom: FittingDomain, s: number): number {
  const t = dom.length < EPS ? 0 : Math.max(0, Math.min(1, s / dom.length));
  const outR = (dom.outletDiameter ?? dom.diameter) / 2;
  const inR = dom.diameter / 2;
  return inR + (outR - inR) * t;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
