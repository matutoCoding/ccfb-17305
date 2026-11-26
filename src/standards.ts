/**
 * 标准数据：ASME B36.10M 钢管外径与壁厚等级、常用材料许用应力
 * 数据为工程常用节选值，单位 mm / MPa，可在界面上覆盖。
 */

export interface PipeDimension {
  dn: number;
  od: number; // 外径
  schedules: Record<string, number>; // 壁厚等级 -> 名义壁厚
}

/** key = DN */
export const PIPE_DIMENSIONS: Record<number, PipeDimension> = {
  15: { dn: 15, od: 21.3, schedules: { SCH40: 2.77, SCH80: 3.73, STD: 2.77, XS: 3.73 } },
  20: { dn: 20, od: 26.9, schedules: { SCH40: 2.87, SCH80: 3.91, STD: 2.87, XS: 3.91 } },
  25: { dn: 25, od: 33.7, schedules: { SCH40: 3.38, SCH80: 4.55, STD: 3.38, XS: 4.55 } },
  40: { dn: 40, od: 48.3, schedules: { SCH40: 3.68, SCH80: 5.08, STD: 3.68, XS: 5.08 } },
  50: { dn: 50, od: 60.3, schedules: { SCH40: 3.91, SCH80: 5.54, STD: 3.91, XS: 5.54 } },
  80: { dn: 80, od: 88.9, schedules: { SCH40: 5.49, SCH80: 7.62, STD: 5.49, XS: 7.62 } },
  100: { dn: 100, od: 114.3, schedules: { SCH40: 6.02, SCH80: 8.56, STD: 6.02, XS: 8.56 } },
  150: { dn: 150, od: 168.3, schedules: { SCH20: 5.56, SCH40: 7.11, SCH80: 10.97, STD: 7.11, XS: 10.97 } },
  200: { dn: 200, od: 219.1, schedules: { SCH20: 6.35, SCH30: 7.04, SCH40: 8.18, SCH80: 12.7, STD: 8.18, XS: 12.7 } },
  250: { dn: 250, od: 273.0, schedules: { SCH20: 6.35, SCH30: 7.8, SCH40: 9.27, SCH80: 15.09, STD: 9.27, XS: 15.09 } },
  300: { dn: 300, od: 323.9, schedules: { SCH20: 7.14, SCH30: 8.38, SCH40: 10.31, SCH80: 17.48, STD: 10.31, XS: 17.48 } },
  350: { dn: 350, od: 355.6, schedules: { SCH20: 7.92, SCH30: 9.53, SCH40: 11.13, STD: 11.13 } },
  400: { dn: 400, od: 406.4, schedules: { SCH20: 7.92, SCH30: 9.53, SCH40: 12.7, STD: 12.7 } },
  450: { dn: 450, od: 457.0, schedules: { SCH20: 7.92, SCH30: 11.13, SCH40: 14.27, STD: 14.27 } },
  500: { dn: 500, od: 508.0, schedules: { SCH20: 9.53, SCH30: 12.7, SCH40: 15.09, STD: 15.09 } },
  600: { dn: 600, od: 610.0, schedules: { SCH20: 9.53, SCH30: 14.27, SCH40: 17.48, STD: 17.48 } },
};

export function lookupOuterDiameter(dn: number): number | undefined {
  return PIPE_DIMENSIONS[dn]?.od;
}

export function lookupNominalWall(dn: number, schedule: string): number | undefined {
  const dim = PIPE_DIMENSIONS[dn];
  if (!dim) return undefined;
  return dim.schedules[schedule.toUpperCase()] ?? dim.schedules['STD'];
}

export interface MaterialSpec {
  grade: string;
  /** 不同温度档(℃)下的许用应力 MPa（ASME II-D 常用值节选，线性插值） */
  tempPoints: number[];
  allowableStress: number[];
}

export const MATERIALS: Record<string, MaterialSpec> = {
  '20#': {
    grade: '20#',
    tempPoints: [20, 100, 200, 300, 400, 450],
    allowableStress: [137, 132, 123, 110, 92, 62],
  },
  'Q245R': {
    grade: 'Q245R',
    tempPoints: [20, 100, 200, 300, 400, 450],
    allowableStress: [147, 144, 134, 117, 98, 62],
  },
  'Q345R': {
    grade: 'Q345R',
    tempPoints: [20, 100, 200, 300, 400, 450],
    allowableStress: [189, 189, 183, 168, 144, 87],
  },
  '20G': {
    grade: '20G',
    tempPoints: [20, 100, 200, 300, 400, 450, 475],
    allowableStress: [140, 140, 132, 118, 100, 70, 55],
  },
  '15CrMoG': {
    grade: '15CrMoG',
    tempPoints: [20, 100, 200, 300, 400, 500, 550],
    allowableStress: [157, 157, 150, 140, 126, 76, 46],
  },
  '304': {
    grade: '304',
    tempPoints: [20, 100, 200, 300, 400, 500, 600],
    allowableStress: [137, 137, 115, 103, 94, 85, 60],
  },
  '316L': {
    grade: '316L',
    tempPoints: [20, 100, 200, 300, 400, 500, 600],
    allowableStress: [117, 117, 100, 89, 82, 74, 60],
  },
};

/** 线性插值取设计温度下许用应力 */
export function allowableStressAt(grade: string, tempC: number): number {
  const m = MATERIALS[grade];
  if (!m) throw new Error(`未知材料牌号: ${grade}`);
  const t = Math.max(m.tempPoints[0], Math.min(m.tempPoints[m.tempPoints.length - 1], tempC));
  for (let i = 0; i < m.tempPoints.length - 1; i++) {
    const t0 = m.tempPoints[i];
    const t1 = m.tempPoints[i + 1];
    if (t >= t0 && t <= t1) {
      const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return m.allowableStress[i] + (m.allowableStress[i + 1] - m.allowableStress[i]) * f;
    }
  }
  return m.allowableStress[m.allowableStress.length - 1];
}

/** 测量误差默认阈值 mm（两期对比可疑点判定） */
export const DEFAULT_MEASUREMENT_ERROR_MM = 0.1;
/** 英寸判定阈值：数值小于名义壁厚的 15% 视为单位填错（25.4 换算后会异常大） */
export const INCH_RATIO_THRESHOLD = 0.15;
