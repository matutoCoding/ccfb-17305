/**
 * 管壁网格生成：每个域独立出网格，顶点携带 (domainIndex, s, theta)，
 * 云图着色时按这三个参数查壁厚场 —— 几何与数据严格同源。
 * 不做布尔运算：三通处用融合球遮盖交线。
 */
import { Fitting } from '../types';
import { clockToTheta, v3 } from '../math/vector';
import {
  FittingDomain,
  PipelineGeometry,
  sampleDomain,
  surfaceRadius,
} from './centerline';
import { sectionFrame } from '../math/vector';

export interface TubeMesh {
  positions: Float32Array;
  normals: Float32Array;
  sAttr: Float32Array;
  thetaAttr: Float32Array;
  domainAttr: Float32Array; // WGSL 纹理索引统一用 f32
  indices: Uint32Array;
  /** 每个域在索引缓冲中的范围与颜色缓冲位置 */
  domainIndex: Map<string, number>;
  domains: { index: number; fittingId: string; vertexOffset: number; indexOffset: number; indexCount: number }[];
  junctionSpheres: { center: [number, number, number]; radius: number }[];
}

const RADIAL_SEGMENTS = 24;

function ringSegments(dom: FittingDomain): number {
  if (dom.kind === 'BEND') {
    return Math.max(12, Math.ceil((dom.bend!.angleRad * dom.bend!.radius) / Math.max(40, dom.diameter / 4)));
  }
  return Math.max(2, Math.ceil(dom.length / Math.max(60, dom.diameter / 2)));
}

export function buildTubeMesh(
  geo: PipelineGeometry,
  fittingsById: Map<string, Fitting>,
): TubeMesh {
  const pos: number[] = [];
  const nor: number[] = [];
  const sA: number[] = [];
  const tA: number[] = [];
  const dA: number[] = [];
  const idx: number[] = [];
  const domainIndex = new Map<string, number>();
  const domains: TubeMesh['domains'] = [];

  geo.domains.forEach((dom, di) => {
    domainIndex.set(dom.fittingId, di);
    const fitting = fittingsById.get(dom.fittingId);
    const rings = ringSegments(dom);
    const vertexOffset = pos.length / 3;
    const indexOffset = idx.length;

    for (let i = 0; i <= rings; i++) {
      const s = (dom.length * i) / rings;
      const { point, tangent } = sampleDomain(dom, s);
      const { side, up } = sectionFrame(tangent);
      let baseR = surfaceRadius(dom, s);
      // 法兰：两端加厚凸缘
      let flangeLip = 0;
      if (fitting?.kind === 'FLANGE') {
        const edge = Math.min(s, dom.length - s);
        if (edge < dom.diameter * 0.12) flangeLip = dom.diameter * 0.12;
      }
      // 阀门：中部鼓包
      let valveBulge = 0;
      if (fitting?.kind === 'VALVE') {
        const t = dom.length < 1e-9 ? 0 : s / dom.length;
        valveBulge = dom.diameter * 0.28 * Math.sin(Math.PI * t);
      }
      // 偏心大小头中心线平移
      let center = point;
      if (dom.reducerEccentric) {
        const t = dom.length < 1e-9 ? 0 : s / dom.length;
        center = v3.add(point, v3.scale(up, dom.reducerEccentric * (1 - t)));
      }
      const r = baseR + flangeLip + valveBulge;
      for (let j = 0; j < RADIAL_SEGMENTS; j++) {
        const theta = clockToTheta(1 + (12 * j) / RADIAL_SEGMENTS);
        const sin = Math.sin(theta);
        const cos = Math.cos(theta);
        const n = v3.norm([
          up[0] * cos + side[0] * sin,
          up[1] * cos + side[1] * sin,
          up[2] * cos + side[2] * sin,
        ]);
        pos.push(center[0] + n[0] * r, center[1] + n[1] * r, center[2] + n[2] * r);
        nor.push(n[0], n[1], n[2]);
        sA.push(s);
        tA.push(theta);
        dA.push(di);
      }
    }

    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < RADIAL_SEGMENTS; j++) {
        const a = vertexOffset + i * RADIAL_SEGMENTS + j;
        const b = vertexOffset + i * RADIAL_SEGMENTS + ((j + 1) % RADIAL_SEGMENTS);
        const c = vertexOffset + (i + 1) * RADIAL_SEGMENTS + j;
        const d = vertexOffset + (i + 1) * RADIAL_SEGMENTS + ((j + 1) % RADIAL_SEGMENTS);
        idx.push(a, c, b, b, c, d);
      }
    }
    domains.push({
      index: di, fittingId: dom.fittingId, vertexOffset,
      indexOffset, indexCount: idx.length - indexOffset,
    });
  });

  const junctionSpheres = geo.junctions.map((j) => ({
    center: j.point as [number, number, number],
    radius: j.diameter / 2,
  }));

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    sAttr: new Float32Array(sA),
    thetaAttr: new Float32Array(tA),
    domainAttr: new Float32Array(dA),
    indices: new Uint32Array(idx),
    domainIndex,
    domains,
    junctionSpheres,
  };
}

/** 截面圆环（剖切显示）：返回外圈/内圈顶点与法线方向，厚度由调用方按场查 */
export function sectionRing(
  dom: FittingDomain,
  s: number,
  thickness: number,
  segments = 64,
): { outer: Float32Array; inner: Float32Array; theta: Float32Array } {
  const { point, tangent } = sampleDomain(dom, s);
  const { side, up } = sectionFrame(tangent);
  let center = point;
  if (dom.reducerEccentric) {
    const t = dom.length < 1e-9 ? 0 : s / dom.length;
    center = v3.add(point, v3.scale(up, dom.reducerEccentric * (1 - t)));
  }
  const rOut = surfaceRadius(dom, s);
  const rIn = Math.max(0.5, rOut - thickness);
  const outer = new Float32Array(segments * 3);
  const inner = new Float32Array(segments * 3);
  const theta = new Float32Array(segments);
  for (let j = 0; j < segments; j++) {
    const th = (j / segments) * Math.PI * 2;
    const sin = Math.sin(th);
    const cos = Math.cos(th);
    const n = v3.norm([
      up[0] * cos + side[0] * sin,
      up[1] * cos + side[1] * sin,
      up[2] * cos + side[2] * sin,
    ]);
    outer[j * 3] = center[0] + n[0] * rOut;
    outer[j * 3 + 1] = center[1] + n[1] * rOut;
    outer[j * 3 + 2] = center[2] + n[2] * rOut;
    inner[j * 3] = center[0] + n[0] * rIn;
    inner[j * 3 + 1] = center[1] + n[1] * rIn;
    inner[j * 3 + 2] = center[2] + n[2] * rIn;
    theta[j] = th;
  }
  return { outer, inner, theta };
}
