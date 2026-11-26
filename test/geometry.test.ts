import { describe, expect, it } from 'vitest';
import { Fitting, Pipeline } from '../src/types';
import { buildGeometry, sampleDomain, bendSideTheta } from '../src/geometry/centerline';
import { placePoints } from '../src/geometry/placement';
import { v3 } from '../src/math/vector';

function pipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: 'L1', unit: 'u', subUnit: 's', lineNo: 'L1', service: '油气',
    designPressure: 0.6, operatingPressure: 0.3, designTemp: 200, operatingTemp: 180,
    material: '20#', corrosionAllowance: 1.5, nominalDiameter: 150,
    wallSchedule: 'SCH40', outerDiameter: 168.3, nominalWall: 7.11,
    weldJointEfficiency: 1, createdAt: 0, updatedAt: 0, ...overrides,
  };
}

function fitting(seq: number, part: Partial<Fitting>): Fitting {
  return {
    id: `F${seq}`, pipelineId: 'L1', seq, kind: 'PIPE', length: 1000,
    direction: '+X', tag: `L1-T${seq}`, ...part,
  };
}

describe('中心线建模', () => {
  it('90°长半径弯头弧长与端点位置正确 (R=1.5DN)', () => {
    const dn = 150;
    const R = 1.5 * dn;
    const arc = (Math.PI / 2) * R;
    const list = [
      fitting(0, { kind: 'PIPE', length: 1000, direction: '+X', tag: 'L1-P1' }),
      fitting(1, {
        kind: 'ELBOW', length: arc, direction: '+X', exitDirection: '+Y',
        elbowAngle: 90, elbowRadiusType: 'LR', bendRadius: R, tag: 'L1-E1',
      }),
      fitting(2, { kind: 'PIPE', length: 2000, direction: '+Y', tag: 'L1-P2' }),
    ];
    const geo = buildGeometry(pipeline(), list);
    expect(geo.issues).toEqual([]);
    const elbow = geo.domainByFitting.get('F1')!;
    expect(elbow.kind).toBe('BEND');
    expect(elbow.length).toBeCloseTo(arc, 4);
    // 弯头入口 (1000,0,0)，+X→+Y 圆心 (1000,+R,0)，出口 (1000+R,R,0)
    expect(elbow.start[0]).toBeCloseTo(1000, 6);
    expect(elbow.centerline?.at(-1)?.point[0]).toBeCloseTo(1000 + R, 6);
    expect(elbow.centerline?.at(-1)?.point[1]).toBeCloseTo(R, 6);
    // 出口切线 = +Y
    const endTan = sampleDomain(elbow, elbow.length).tangent;
    expect(endTan[1]).toBeCloseTo(1, 6);
    // 走向接不上检测
    const bad = buildGeometry(pipeline(), [
      ...list.slice(0, 2),
      fitting(2, { kind: 'PIPE', length: 2000, direction: '+Z', tag: 'L1-P2' }),
    ]);
    expect(bad.issues.some((i) => i.code === 'DIRECTION_MISMATCH')).toBe(true);
  });

  it('总长与图纸不符时报 LENGTH_MISMATCH', () => {
    const list = [fitting(0, { length: 1000, tag: 'L1-P1' })];
    const geo = buildGeometry(pipeline({ drawingTotalLength: 1200 }), list);
    expect(geo.issues.some((i) => i.code === 'LENGTH_MISMATCH')).toBe(true);
  });

  it('45°弯头夹角校验', () => {
    const R = 1.5 * 150;
    const list = [
      fitting(0, { kind: 'ELBOW', direction: '+X', exitDirection: '+Y', elbowAngle: 45, bendRadius: R, length: R * Math.PI / 4, tag: 'L1-E1' }),
    ];
    const geo = buildGeometry(pipeline(), list);
    expect(geo.issues.some((i) => i.code === 'UNSUPPORTED_BEND_PLANE')).toBe(true);
  });
});

describe('测点钟点落点（2% 管径精度）', () => {
  it('直管 12/3/6/9 点落在对应方位且在管面上', () => {
    const list = [fitting(0, { kind: 'PIPE', length: 2000, direction: '+X', tag: 'L1-P1' })];
    const geo = buildGeometry(pipeline(), list);
    const dom = geo.domainByFitting.get('F0')!;
    const points = [12, 3, 6, 9].map((c, i) => ({
      id: `P${i}`, pipelineId: 'L1', fittingId: 'F0', pointNo: `T${i}`,
      axialDistance: 1000, clock: c, bendSide: 'NONE' as const,
    }));
    const res = placePoints(geo, points);
    expect(res.errors).toEqual([]);
    const r = dom.diameter / 2;
    const at = (clock: number) => res.placements.find((_, i) => points[i].clock === clock)!;
    // 12 点：+Y；6 点：-Y；3 点：顺流向(+X)看右侧 = -Z（side=up×f）
    expect(v3.dist(at(12).position, [1000, r, 0])).toBeLessThan(dom.diameter * 0.02);
    expect(v3.dist(at(6).position, [1000, -r, 0])).toBeLessThan(dom.diameter * 0.02);
    expect(v3.dist(at(3).position, [1000, 0, -r])).toBeLessThan(dom.diameter * 0.02);
    expect(v3.dist(at(9).position, [1000, 0, r])).toBeLessThan(dom.diameter * 0.02);
    // 法线是径向单位向量
    for (const pl of res.placements) {
      expect(Math.hypot(...pl.normal)).toBeCloseTo(1, 6);
    }
  });

  it('弯头上按钟点+弧长录入的测点落点偏差 < 2% 管径，内外弧标注与几何一致', () => {
    const dn = 150;
    const R = 1.5 * dn;
    const arc = (Math.PI / 2) * R;
    const list = [
      fitting(0, { kind: 'PIPE', length: 500, direction: '+X', tag: 'L1-P1' }),
      fitting(1, {
        kind: 'ELBOW', direction: '+X', exitDirection: '+Y', elbowAngle: 90,
        bendRadius: R, length: arc, tag: 'L1-E1',
      }),
    ];
    const geo = buildGeometry(pipeline(), list);
    const dom = geo.domainByFitting.get('F1')!;
    const sMid = arc / 2;
    const thetaExtra = bendSideTheta(dom, sMid, 'EXTRADOS');
    const thetaIntra = bendSideTheta(dom, sMid, 'INTRADOS');
    const points = [
      { id: 'EX', pipelineId: 'L1', fittingId: 'F1', pointNo: 'EX', axialDistance: sMid, clock: clockToClock(thetaExtra), bendSide: 'EXTRADOS' as const },
      { id: 'IN', pipelineId: 'L1', fittingId: 'F1', pointNo: 'IN', axialDistance: sMid, clock: clockToClock(thetaIntra), bendSide: 'INTRADOS' as const },
    ];
    const res = placePoints(geo, points);
    expect(res.errors).toEqual([]);
    const ex = res.placementByPoint.get('EX')!;
    const inp = res.placementByPoint.get('IN')!;
    // 外弧点：弯心 (500+R,0,0)，外弧中点 = 中心 + R·径向(45°)，再加管壁半径
    const center = dom.bend!.center;
    const expectedExtra = v3.add(
      v3.add(center, v3.scale(dom.bend!.extradosNormal, R)),
      v3.scale(dom.bend!.extradosNormal, dn * 0 + dom.diameter / 2),
    );
    expect(v3.dist(ex.position, expectedExtra)).toBeLessThan(dom.diameter * 0.02);
    // 内外弧外壁点到弯心距离分别为 R+r 与 R-r；两点外法线方向相反
    const r = dom.diameter / 2;
    const exFromCenter = v3.sub(ex.position, center);
    const inFromCenter = v3.sub(inp.position, center);
    expect(v3.len(exFromCenter)).toBeCloseTo(R + r, 4);
    expect(v3.len(inFromCenter)).toBeCloseTo(R - r, 4);
    expect(v3.dot(ex.normal, inp.normal)).toBeLessThan(-0.999);
    // 内外弧在同一条径向线上
    expect(v3.dot(v3.norm(exFromCenter), v3.norm(inFromCenter))).toBeGreaterThan(0.999);
    expect(ex.bendSide).toBe('EXTRADOS');
    expect(inp.bendSide).toBe('INTRADOS');
    // 错误标注必须被抓到
    const bad = placePoints(geo, [{ ...points[1], id: 'BAD', pointNo: 'BAD', bendSide: 'EXTRADOS' }]);
    expect(bad.errors).toHaveLength(1);
  });

  it('超界轴向距离报错', () => {
    const list = [fitting(0, { kind: 'PIPE', length: 500, direction: '+X', tag: 'L1-P1' })];
    const geo = buildGeometry(pipeline(), list);
    const res = placePoints(geo, [
      { id: 'X', pipelineId: 'L1', fittingId: 'F0', pointNo: 'X', axialDistance: 999, clock: 12, bendSide: 'NONE' },
    ]);
    expect(res.errors).toHaveLength(1);
  });
});

function clockToClock(theta: number): number {
  const c = (theta / (2 * Math.PI)) * 12;
  return c < 1e-9 ? 12 : c;
}
