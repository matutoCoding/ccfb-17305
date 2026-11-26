// 领域模型类型定义

export type ID = string

/** 管件类型 */
export type FittingKind =
  | 'pipe' // 直管段
  | 'elbow_lr' // 长半径弯头 R=1.5DN
  | 'elbow_sr' // 短半径弯头 R=1.0DN
  | 'elbow45' // 45度弯头 R=1.5DN
  | 'tee' // 三通
  | 'reducer_conc' // 同心大小头
  | 'reducer_ecc' // 偏心大小头
  | 'flange' // 法兰
  | 'valve_gate' // 闸阀
  | 'valve_check' // 止回阀
  | 'valve_ball' // 球阀
  | 'cap' // 盲端/管帽

/** 三维向量 */
export type Vec3 = [number, number, number]

/** 管线档案 */
export interface Pipeline {
  id: ID
  code: string // 管线号
  unit: string // 装置
  block: string // 单元/工段
  medium: string // 介质
  opTempC: number // 操作温度 ℃
  opPressureMPa: number // 操作压力 MPa
  designPressureMPa: number // 设计压力 MPa
  material: string // 材质
  allowableStressMPa: number // 许用应力 [σ]^t MPa
  weldEfficiency: number // 焊接接头系数 E
  corrosionAllowanceMm: number // 腐蚀裕量 CA
  dn: number // 公称直径 mm
  nps?: string
  schedule: string // 壁厚等级
  outerDiameterMm: number // 外径 OD（自动带出）
  nominalWallMm: number // 名义壁厚 T_nom（自动带出）
  inspectionCycleYears: number // 检验周期
  drawingTotalLengthM?: number // 图纸总长 m（用于核对）
  note?: string
}

/** 走向段（管件）录入 */
export interface Fitting {
  id: ID
  pipelineId: ID
  seq: number // 顺序
  code: string // 管件编号
  kind: FittingKind
  /** 直管长度 mm（pipe / 法兰阀门结构长度可内置） */
  lengthMm: number
  /**
   * 出口方向（世界坐标主轴方向）。
   * 录入时给出该段"物料流出方向"，首段给出入口走向。
   * 弯头通过 inDir/outDir 自动求弧面。
   */
  dir: Vec3
  /** 入口方向，缺省等于上一段 dir（用于弯头校核） */
  inDir?: Vec3
  /** 大小头/三通支管等第二公称直径 */
  dn2?: number
  outerDiameter2Mm?: number
  /** 偏心大小头偏心方向 */
  eccSide?: 'top' | 'bottom' | 'left' | 'right'
  /** 三通：直通还是支管测点语义 */
  teePort?: 'run' | 'branch'
  /** 法兰/焊口屏障：该件两端是否为插值屏障（默认 true） */
  barrierStart?: boolean
  barrierEnd?: boolean
  note?: string
}

/** 钟点位置：12 = 正上方，按流向定义左右；支持小数钟点 */
export type ClockHour = number // 0..12，如 3、6、9，外弧/内弧由几何自动判定

/** 测厚点 */
export interface ThicknessPoint {
  id: ID
  pipelineId: ID
  fittingId: ID
  code: string // 点号
  /** 相对哪道焊口/基准端面的轴向距离 mm */
  reference: 'upstream_weld' | 'downstream_weld' | 'fitting_start' | 'fitting_end'
  axialDistanceMm: number
  /** 钟点 0..12 */
  clock: ClockHour
  /** 弯头弧侧语义（可显式标注，几何也会反算） */
  arcSide?: 'inner' | 'outer' | 'neutral'
  /** 测点覆盖类别，用于检验计划 */
  zone?: 'elbow_outer' | 'elbow_inner' | 'tee_dead' | 'injection_downstream' | 'normal'
  isCscan?: boolean
  active?: boolean
}

/** 单次测厚读数 */
export interface Reading {
  id: ID
  pointId: ID
  pipelineId: ID
  periodId: ID
  date: string // ISO
  thicknessMm: number
  /** 是否可疑（后期比前期厚出测量误差），可疑不参与速率 */
  suspicious?: boolean
  excluded?: boolean
  source?: string
}

/** 测厚一期 */
export interface InspectionPeriod {
  id: ID
  name: string // 如 2023 大修
  date: string
  order: number
}

/** C 扫描网格（弯头外弧超声网格） */
export interface CScanGrid {
  id: ID
  pipelineId: ID
  fittingId: ID
  periodId: ID
  pointCode?: string
  /** 轴向弧长坐标起点/步长 mm */
  axialStartMm: number
  axialStepMm: number
  axialCount: number
  /** 沿弧宽（钟点方向）起点钟点/步长(小时)/数量 */
  clockStart: number
  clockStepHours: number
  clockCount: number
  /** 行优先 thickness[axial][clock] */
  values: number[]
}

/** CSV 导入坏行 */
export interface BadRow {
  id: ID
  fileName: string
  rowNumber: number
  raw: string
  reason: string
  category: 'unknown_point' | 'too_thick' | 'inch_unit' | 'parse' | 'other'
  createdAt: string
}

/** 导入批次 */
export interface ImportBatch {
  id: ID
  fileName: string
  periodId?: ID
  importedAt: string
  totalRows: number
  okRows: number
  badRows: number
}

/** 检验建议加点 */
export interface SuggestedPoint {
  id: ID
  pipelineId: ID
  fittingId: ID
  reason: string
  priority: 'high' | 'medium' | 'low'
  clock: number
  axialDistanceMm: number
  reference: ThicknessPoint['reference']
  zone: NonNullable<ThicknessPoint['zone']>
  createdAt: string
}

/** 持久化整体结构（IndexedDB 各 store） */
export interface DBShape {
  pipelines: Pipeline
  fittings: Fitting
  points: ThicknessPoint
  readings: Reading
  periods: InspectionPeriod
  cscans: CScanGrid
  badrows: BadRow
  batches: ImportBatch
  suggestions: SuggestedPoint
  meta: { key: string; value: unknown }
}
