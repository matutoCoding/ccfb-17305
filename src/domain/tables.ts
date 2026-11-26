// 公称直径 -> 外径 / 壁厚等级 数据（ASME B36.10M / B36.19M 常用值，单位 mm）
// 仅收录常减压装置常用 DN15~DN1200；查不到的等级给出按标准的近似并允许手改。

export interface PipeSizeRow {
  dn: number
  nps: string
  od: number
  /** 各壁厚等级名义壁厚 mm */
  walls: Record<string, number>
}

// 常用等级：Sch20 / STD / Sch40 / XS / Sch80 / Sch160
export const PIPE_SIZES: PipeSizeRow[] = [
  { dn: 15, nps: '1/2"', od: 21.3, walls: { STD: 2.77, Sch40: 2.77, XS: 3.73, Sch80: 3.73, Sch160: 4.78 } },
  { dn: 20, nps: '3/4"', od: 26.7, walls: { STD: 2.87, Sch40: 2.87, XS: 3.91, Sch80: 3.91, Sch160: 5.56 } },
  { dn: 25, nps: '1"', od: 33.4, walls: { STD: 3.38, Sch40: 3.38, XS: 4.55, Sch80: 4.55, Sch160: 6.35 } },
  { dn: 40, nps: '1-1/2"', od: 48.3, walls: { STD: 3.68, Sch40: 3.68, XS: 5.08, Sch80: 5.08, Sch160: 7.14 } },
  { dn: 50, nps: '2"', od: 60.3, walls: { STD: 3.91, Sch40: 3.91, XS: 5.54, Sch80: 5.54, Sch160: 8.74 } },
  { dn: 80, nps: '3"', od: 88.9, walls: { STD: 5.49, Sch40: 5.49, XS: 7.62, Sch80: 7.62, Sch160: 11.13 } },
  { dn: 100, nps: '4"', od: 114.3, walls: { STD: 6.02, Sch40: 6.02, XS: 8.56, Sch80: 8.56, Sch120: 11.13, Sch160: 13.49 } },
  { dn: 150, nps: '6"', od: 168.3, walls: { STD: 7.11, Sch40: 7.11, XS: 10.97, Sch80: 10.97, Sch120: 14.27, Sch160: 18.26 } },
  { dn: 200, nps: '8"', od: 219.1, walls: { Sch20: 6.35, STD: 8.18, Sch40: 8.18, XS: 12.7, Sch80: 10.31, Sch100: 12.7, Sch120: 18.26 } },
  { dn: 250, nps: '10"', od: 273.0, walls: { Sch20: 6.35, STD: 9.27, Sch40: 9.27, XS: 12.7, Sch80: 12.7, Sch100: 15.09, Sch120: 21.44 } },
  { dn: 300, nps: '12"', od: 323.9, walls: { Sch20: 6.35, STD: 9.53, Sch40: 10.31, XS: 12.7, Sch80: 12.7, Sch100: 17.48, Sch120: 25.4 } },
  { dn: 350, nps: '14"', od: 355.6, walls: { Sch20: 7.92, STD: 9.53, Sch40: 11.13, XS: 12.7, Sch80: 12.7, Sch100: 19.05, Sch120: 27.79 } },
  { dn: 400, nps: '16"', od: 406.4, walls: { Sch20: 7.92, STD: 9.53, Sch40: 12.7, XS: 12.7, Sch80: 12.7, Sch100: 21.44, Sch120: 30.96 } },
  { dn: 450, nps: '18"', od: 457.0, walls: { Sch20: 7.92, STD: 9.53, Sch40: 14.27, XS: 12.7, Sch80: 14.27, Sch100: 23.83 } },
  { dn: 500, nps: '20"', od: 508.0, walls: { Sch20: 9.53, STD: 9.53, Sch40: 15.09, XS: 12.7, Sch80: 15.09, Sch100: 26.19 } },
  { dn: 600, nps: '24"', od: 610.0, walls: { Sch20: 9.53, STD: 9.53, Sch40: 17.48, XS: 12.7, Sch80: 17.48, Sch100: 30.96 } },
  { dn: 700, nps: '28"', od: 711.0, walls: { Sch20: 9.53, STD: 9.53, Sch30: 12.7, Sch40: 15.88, XS: 12.7 } },
  { dn: 800, nps: '32"', od: 813.0, walls: { Sch20: 9.53, STD: 9.53, Sch30: 12.7, Sch40: 17.48 } },
  { dn: 900, nps: '36"', od: 914.0, walls: { Sch20: 9.53, STD: 9.53, Sch30: 12.7, Sch40: 19.05 } },
  { dn: 1000, nps: '40"', od: 1016.0, walls: { Sch20: 9.53, STD: 9.53, Sch30: 12.7 } },
  { dn: 1200, nps: '48"', od: 1219.0, walls: { Sch20: 11.13, STD: 9.53, Sch30: 14.27 } }
]

export const SCHEDULES = ['Sch20', 'STD', 'Sch40', 'XS', 'Sch80', 'Sch100', 'Sch120', 'Sch160']

export function lookupSize(dn: number): PipeSizeRow | undefined {
  return PIPE_SIZES.find((r) => r.dn === dn)
}

export function lookupOd(dn: number): number {
  const row = lookupSize(dn)
  if (row) return row.od
  // 大口径焊管近似：DN 与 OD 接近
  return dn
}

export function lookupWall(dn: number, schedule: string): number | undefined {
  const row = lookupSize(dn)
  if (!row) return undefined
  if (row.walls[schedule] != null) return row.walls[schedule]
  // STD 与 Sch40 在 ≤DN100 常相同；做一次兜底
  if (schedule === 'Sch40' && row.walls.STD != null) return row.walls.STD
  return undefined
}

/** 常见材质在设计温度下的许用应力 MPa（简化取值，用于演示计算） */
export const MATERIAL_STRESS: Record<string, { S: number; E: number; note: string }> = {
  '20#': { S: 137, E: 1.0, note: '优质碳素钢，≤350℃' },
  '20G': { S: 138, E: 1.0, note: '锅炉用碳素钢' },
  'Q245R': { S: 140, E: 1.0, note: '容器板' },
  '15CrMo': { S: 150, E: 1.0, note: '耐热低合金钢' },
  '1Cr5Mo': { S: 128, E: 1.0, note: '加热炉管' },
  '304': { S: 137, E: 1.0, note: '奥氏体不锈钢' },
  '316L': { S: 117, E: 1.0, note: '低碳不锈钢，耐塔顶低温腐蚀' },
  '2205': { S: 230, E: 1.0, note: '双相钢' },
  '碳钢+衬里': { S: 137, E: 0.85, note: '衬里/焊缝系数折减' }
}
