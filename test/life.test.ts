import { describe, expect, it } from 'vitest';
import {
  Fitting, InspectionRound, Pipeline, ThicknessPoint,
} from '../src/types';
import { assess, minRequiredThickness, YEAR_MS } from '../src/thickness/life';
import { parseThicknessCsv } from '../src/thickness/csv-import';
import { diffRounds } from '../src/thickness/diff';
import { buildField, FieldSample, ThicknessField } from '../src/thickness/field';

const now = Date.UTC(2025, 5, 1);

function pipeline(): Pipeline {
  return {
    id: 'L1', unit: 'u', subUnit: 's', lineNo: 'L1', service: 'x',
    designPressure: 0.6, operatingPressure: 0.3, designTemp: 200, operatingTemp: 180,
    material: '20#', corrosionAllowance: 1.5, nominalDiameter: 150,
    wallSchedule: 'SCH40', outerDiameter: 168.3, nominalWall: 7.11,
    weldJointEfficiency: 1, createdAt: 0, updatedAt: 0,
  };
}
const fitting: Fitting = {
  id: 'F0', pipelineId: 'L1', seq: 0, kind: 'PIPE', tag: 'L1-P1',
  length: 2000, direction: '+X',
};
const point: ThicknessPoint = {
  id: 'PT1', pipelineId: 'L1', fittingId: 'F0', pointNo: 'L1-P1-T01',
  axialDistance: 500, clock: 12, bendSide: 'NONE',
};
const rounds: InspectionRound[] = [
  { id: 'R0', name: '2022', inspectDate: now - 3 * YEAR_MS },
  { id: 'R1', name: '2023', inspectDate: now - 2 * YEAR_MS },
  { id: 'R2', name: '2024', inspectDate: now - YEAR_MS },
];

describe('API570 寿命评估', () => {
  it('最小要求壁厚 = 内压厚度 + 腐蚀裕量，弯头乘 1.25', () => {
    const p = pipeline();
    const tStraight = minRequiredThickness(p, fitting, 123);
    // 手算: 0.6*168.3/(2*(123+0.6*0.4)) + 1.5
    const press = (0.6 * 168.3) / (2 * (123 + 0.6 * 0.4));
    expect(tStraight).toBeCloseTo(press + 1.5, 3);
    const elbow: Fitting = { ...fitting, id: 'E', kind: 'ELBOW', tag: 'L1-E1' };
    expect(minRequiredThickness(p, elbow, 123)).toBeCloseTo((press) * 1.25 + 1.5, 3);
  });

  it('长短期速率、剩余寿命与下次检验日期', () => {
    const readings = new Map([[point.id, new Map([
      ['R0', { thickness: 7.0, suspicious: false }],
      ['R1', { thickness: 6.6, suspicious: false }], // 0.4/a
      ['R2', { thickness: 5.8, suspicious: false }], // 短期 0.8/a
    ])]]);
    const res = assess({
      pipeline: pipeline(), fittings: [fitting], points: [point], rounds,
      readings, latestGrids: new Map(), latestRoundId: 'R2', now,
    });
    const st = res.pointStats[0];
    expect(st.longTermRate).toBeCloseTo(0.6, 2); // (7.0-5.8)/2
    expect(st.shortTermRate).toBeCloseTo(0.8, 2);
    expect(st.governingRate).toBeCloseTo(0.8, 2);
    const tMin = st.tMin;
    expect(st.remainingLifeYears).toBeCloseTo((5.8 - tMin) / 0.8, 1);
    expect(st.nextInspectionDate).not.toBeNull();
    // 下次检验 ≈ now + RL/2
    const interval = (st.nextInspectionDate! - now) / YEAR_MS;
    expect(interval).toBeCloseTo(st.remainingLifeYears / 2, 1);
  });

  it('可疑增厚点不参与速率计算', () => {
    const readings = new Map([[point.id, new Map([
      ['R0', { thickness: 7.0, suspicious: false }],
      ['R1', { thickness: 6.5, suspicious: false }],
      ['R2', { thickness: 7.2, suspicious: true }], // 增厚 0.7，被剔除
    ])]]);
    const res = assess({
      pipeline: pipeline(), fittings: [fitting], points: [point], rounds,
      readings, latestGrids: new Map(), latestRoundId: 'R2', now,
    });
    const st = res.pointStats[0];
    expect(st.suspicious).toBe(true);
    // 有效序列只剩两期：长期=短期=0.5
    expect(st.longTermRate).toBeCloseTo(0.5, 2);
  });
});

describe('CSV 导入坏行分类', () => {
  it('点号缺失/超名义/英寸/解析失败分别归类', () => {
    const csv = [
      '点号,厚度(mm)',
      `${point.pointNo},6.5`,
      'GHOST-T99,5.0',
      `${point.pointNo},9.9`,
      `${point.pointNo},0.2`,
      `${point.pointNo},abc`,
    ].join('\n');
    const nominal = new Map([[point.id, 7.11]]);
    const parsed = parseThicknessCsv(csv, [point], nominal);
    expect(parsed.readings).toHaveLength(1);
    const reasons = parsed.badRows.map((b) => b.reason);
    expect(reasons).toContain('POINT_NOT_FOUND');
    expect(reasons).toContain('THICKNESS_EXCEEDS_NOMINAL');
    expect(reasons).toContain('BAD_UNIT_INCH');
    expect(reasons).toContain('PARSE_ERROR');
  });
});

describe('两期对比', () => {
  function field(roundId: string, vals: [number, number][]): { roundId: string; field: ThicknessField } {
    const samples: FieldSample[] = vals.map(([theta, t], i) => ({
      domainId: 'F0', s: 500, theta, thickness: t, pointNo: `P${i}`,
    }));
    return { roundId, field: buildField([], samples) };
  }
  it('增厚超差标记可疑，差值符号为 后-前', () => {
    const a = field('R0', [[0, 7.0], [1, 6.0]]);
    const b = field('R1', [[0, 6.5], [1, 6.2]]);
    // grids 为空 map 时差值网格为空，但点对比仍可用
    const res = diffRounds(a, b, 0.1);
    const d0 = res.pointDiffs.find((d) => d.theta === 0)!;
    const d1 = res.pointDiffs.find((d) => d.theta === 1)!;
    expect(d0.delta).toBeCloseTo(-0.5, 2);
    expect(d0.suspicious).toBe(false);
    expect(d1.delta).toBeCloseTo(0.2, 2);
    expect(d1.suspicious).toBe(true);
    expect(res.suspiciousCount).toBe(1);
  });
});
