import { describe, expect, it } from 'vitest';
import { Fitting, Pipeline } from '../src/types';
import { buildGeometry } from '../src/geometry/centerline';
import { buildField, FieldSample, lookupGrid } from '../src/thickness/field';

function pipeline(): Pipeline {
  return {
    id: 'L1', unit: 'u', subUnit: 's', lineNo: 'L1', service: 'x',
    designPressure: 0.6, operatingPressure: 0.3, designTemp: 200, operatingTemp: 180,
    material: '20#', corrosionAllowance: 1.5, nominalDiameter: 150,
    wallSchedule: 'SCH40', outerDiameter: 168.3, nominalWall: 7.11,
    weldJointEfficiency: 1, createdAt: 0, updatedAt: 0,
  };
}
function elbow(seq: number, dir: 'X' | 'Y', exit: 'X' | 'Y'): Fitting {
  const R = 1.5 * 150;
  const d = dir === 'X' ? '+X' : '+Y';
  const e = exit === 'X' ? '+X' : '+Y';
  return {
    id: `F${seq}`, pipelineId: 'L1', seq, kind: 'ELBOW', tag: `E${seq}`,
    length: (Math.PI / 2) * R, direction: d as never, exitDirection: e as never,
    elbowAngle: 90, elbowRadiusType: 'LR', bendRadius: R,
  };
}

describe('壁厚场插值约束', () => {
  it('外弧减薄不会被插到内弧（同域 IDW + 表面度量）', () => {
    const list = [elbow(0, 'X', 'Y')];
    const geo = buildGeometry(pipeline(), list);
    const dom = geo.domainByFitting.get('F0')!;
    const sMid = dom.length / 2;
    // 外弧 θ 与内弧 θ 相差 π
    const b = dom.bend!;
    const extraTheta = thetaAt(dom, sMid, b.extradosNormal);
    const intraTheta = (extraTheta + Math.PI) % (2 * Math.PI);
    // 外弧放一个 3mm 的极端减薄样本，其余样本 7mm
    const samples: FieldSample[] = [{
      domainId: 'F0', s: sMid, theta: extraTheta, thickness: 3, pointNo: 'EX',
    }];
    for (const q of [0.15, 0.85]) {
      samples.push({ domainId: 'F0', s: dom.length * q, theta: extraTheta, thickness: 7 });
      samples.push({ domainId: 'F0', s: dom.length * q, theta: intraTheta, thickness: 7 });
    }
    const field = buildField([dom], samples, 60, 48);
    const grid = field.grids.get('F0')!;
    // 外弧位置必须看到明显减薄
    const vExtra = lookupGrid(grid, sMid, extraTheta);
    expect(vExtra).toBeLessThan(4.2);
    // 内弧位置必须保持 ≈7mm，不允许被 3mm 样本穿透
    const vIntra = lookupGrid(grid, sMid, intraTheta);
    expect(vIntra).toBeGreaterThan(6.5);
    // 二者差值至少 2.5mm，证明减薄被锁在外弧
    expect(vIntra - vExtra).toBeGreaterThan(2.5);
  });

  it('不跨域插值：法兰两侧样本互不影响，无样本域为 NaN', () => {
    const R = 1.5 * 150;
    const list: Fitting[] = [
      { id: 'A', pipelineId: 'L1', seq: 0, kind: 'PIPE', tag: 'A', length: 1000, direction: '+X' },
      { id: 'B', pipelineId: 'L1', seq: 1, kind: 'FLANGE', tag: 'B', length: 60, direction: '+X' },
      { id: 'C', pipelineId: 'L1', seq: 2, kind: 'PIPE', tag: 'C', length: 1000, direction: '+X', bendRadius: R } as Fitting,
    ];
    const geo = buildGeometry(pipeline(), list);
    const samples: FieldSample[] = [
      { domainId: 'A', s: 900, theta: 0, thickness: 4 },
      { domainId: 'C', s: 100, theta: 0, thickness: 6.5 },
    ];
    const field = buildField(geo.domains, samples);
    expect(field.grids.get('B')!.hasData).toBe(false);
    expect(Number.isNaN(lookupGrid(field.grids.get('B')!, 30, 0))).toBe(true);
    // C 域靠近焊口处不允许拿到 A 域的 4mm
    const cVal = lookupGrid(field.grids.get('C')!, 100, 0);
    expect(cVal).toBeCloseTo(6.5, 1);
  });

  it('周向环绕：12 点附近插值在 θ=0/2π 边界连续', () => {
    const list: Fitting[] = [{ id: 'A', pipelineId: 'L1', seq: 0, kind: 'PIPE', tag: 'A', length: 1000, direction: '+X' }];
    const geo = buildGeometry(pipeline(), list);
    const dom = geo.domains[0];
    const samples: FieldSample[] = [
      { domainId: 'A', s: 500, theta: 0.1, thickness: 5 },
      { domainId: 'A', s: 500, theta: 2 * Math.PI - 0.1, thickness: 5.2 },
    ];
    const field = buildField([dom], samples, 20, 32);
    const v = lookupGrid(field.grids.get('A')!, 500, 0);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(4.5);
  });
});

import { sampleDomain, FittingDomain } from '../src/geometry/centerline';
import { sectionFrame, normalToTheta } from '../src/math/vector';
function thetaAt(dom: FittingDomain, s: number, normal: number[]): number {
  const { tangent } = sampleDomain(dom, s);
  const { side, up } = sectionFrame(tangent);
  return normalToTheta(side, up, normal as [number, number, number]);
}
