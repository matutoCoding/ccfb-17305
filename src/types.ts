/**
 * 领域数据模型 —— 管线档案 / 等轴测建模 / 测厚点 / 测厚数据
 * 所有持久化对象均带 version 字段，便于后续 IndexedDB 迁移。
 */

export const SCHEMA_VERSION = 1;

/** 方向向量：等轴测建模只用 6 个轴方向 + 自定义方向（斜管） */
export type Direction = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

export const DIR_VECTORS: Record<Direction, [number, number, number]> = {
  '+X': [1, 0, 0],
  '-X': [-1, 0, 0],
  '+Y': [0, 1, 0],
  '-Y': [0, -1, 0],
  '+Z': [0, 0, 1],
  '-Z': [0, 0, -1],
};

/** 管件类型 */
export type FittingKind =
  | 'PIPE' // 直管段
  | 'ELBOW' // 弯头（含长半径 LR / 短半径 SR / 45°）
  | 'TEE' // 三通（支管在末端或中间开孔）
  | 'REDUCER' // 大小头（同心/偏心）
  | 'FLANGE' // 法兰（插值边界）
  | 'VALVE'; // 阀门（插值边界）

export type ElbowRadiusType = 'LR' | 'SR' | 'CUSTOM';
export type ReducerType = 'CONCENTRIC' | 'ECCENTRIC';

/** 管线档案 */
export interface Pipeline {
  id: string;
  unit: string; // 装置
  subUnit: string; // 单元
  lineNo: string; // 管线号，如 HV-1001-150-C2S
  service: string; // 介质
  designPressure: number; // MPa
  operatingPressure: number; // MPa
  designTemp: number; // ℃
  operatingTemp: number; // ℃
  material: string; // 材质牌号（对应 standards 表）
  corrosionAllowance: number; // 腐蚀裕量 mm
  nominalDiameter: number; // 公称直径 DN mm
  wallSchedule: string; // 壁厚等级，如 SCH40
  outerDiameter: number; // 自动带出 mm
  nominalWall: number; // 自动带出 mm
  weldJointEfficiency: number; // 焊接接头系数 E，默认 1.0
  /** 图纸标注的主管展开总长 mm，建模后自动核对，缺省不核对 */
  drawingTotalLength?: number;
  /** 注水点下游管件 tag 列表（冲刷重点） */
  injectionDownstreamTags?: string[];
  createdAt: number;
  updatedAt: number;
}

/** 等轴测管件（一段一段录入） */
export interface Fitting {
  id: string;
  pipelineId: string;
  seq: number; // 录入顺序，决定流向
  kind: FittingKind;
  /** 直管：长度 mm；弯头：角度 45/90；大小头：长度；法兰/阀门：结构长度 */
  length: number;
  direction: Direction; // 该段入口流向（出口方向由几何计算）
  /** 弯头出口流向：末端弯头或下一段方向未变时必填，否则默认取下一段的入口方向 */
  exitDirection?: Direction;
  // 弯头参数
  elbowAngle?: number; // 45 或 90
  elbowRadiusType?: ElbowRadiusType;
  bendRadius?: number; // mm，自定义或由 LR/SR*DN 推出
  // 三通参数
  branchDirection?: Direction; // 支管出口方向
  branchDiameter?: number;
  // 大小头
  reducerType?: ReducerType;
  outletDiameter?: number; // 变径后外径
  eccentricOffset?: number; // 偏心偏移 mm
  // 通用
  diameter?: number; // 该管件外径（沿程可能变径），缺省取管线 OD
  nominalDiameter?: number; // 该管件公称直径 DN（弯头弯曲半径按此算），缺省取管线 DN
  nominalWall?: number; // 该管件名义壁厚
  /** 路由 id：主路为 'main'，支管取三通管件 id */
  routeId?: string;
  /** 三通：支管中心线距该管件入口焊口的轴向距离，默认取 length/2 */
  branchOffset?: number;
  /** 冲刷重点部位标记（注水点下游、弯头外弧等），检验计划用 */
  erosionFocus?: boolean;
  tag: string; // 管件编号，如 HV-1001-E03
  remark?: string;
}

/** 测厚点 */
export interface ThicknessPoint {
  id: string;
  pipelineId: string;
  fittingId: string;
  pointNo: string; // 点号，如 HV-1001-E03-T05
  /** 离入口焊口的轴向距离 mm（弯头上为离入口焊口的中心线弧长 s） */
  axialDistance: number;
  /** 钟点位置 1~12（顺时针，顺流向看，12 点为正上方），允许小数如 1.5 */
  clock: number;
  /** 弯头内弧/外弧/侧弧的显式标注（直管为 NONE） */
  bendSide: 'INTRADOS' | 'EXTRADOS' | 'SIDE' | 'NONE';
  remark?: string;
}

/** 测厚期次 */
export interface InspectionRound {
  id: string;
  name: string; // 如 2023-大修
  inspectDate: number; // 时间戳
  remark?: string;
}

/** 单条测厚读数 */
export interface ThicknessReading {
  id: string;
  roundId: string;
  pointNo: string; // 导入时按点号匹配
  pipelineId?: string;
  thickness: number; // mm
  /** C 扫描网格点用：相对网格基准的周向偏移（钟点），普通点为空 */
  gridClock?: number;
  gridAxial?: number;
}

/** 导入坏行（不进正式读数库） */
export interface BadRow {
  id: string;
  roundId: string;
  source: 'CSV' | 'CSCAN';
  rowIndex: number;
  raw: string;
  reason:
    | 'POINT_NOT_FOUND' // 点号找不到
    | 'THICKNESS_EXCEEDS_NOMINAL' // 大于名义壁厚
    | 'BAD_UNIT_INCH' // 单位疑似英寸（数值过小）
    | 'PARSE_ERROR';
  detail: string;
}

/** C 扫描网格（弯头外弧） */
export interface CScanGrid {
  id: string;
  roundId: string;
  fittingId: string;
  pointNoBase: string; // 网格归属的基准点号
  axialStart: number;
  axialStep: number;
  clockStart: number;
  clockStep: number;
  rows: number;
  cols: number;
  /** rows*cols 厚度矩阵，行=轴向，列=钟点；NaN 表示空 */
  values: number[];
}

/** 几何计算结果：测点在三维空间的落点 */
export interface PointPlacement {
  pointId: string;
  position: [number, number, number];
  normal: [number, number, number]; // 管壁外法线
  /** 参数坐标：所属域 id + 弧长 s(mm) + 周向角 θ(rad)，插值与拾取共用 */
  domainId: string;
  s: number;
  theta: number;
  bendSide: 'INTRADOS' | 'EXTRADOS' | 'SIDE' | 'NONE';
}

/** 建模校验问题 */
export interface ModelingIssue {
  fittingId: string;
  seq: number;
  level: 'ERROR' | 'WARN';
  code:
    | 'DIRECTION_MISMATCH' // 走向接不上
    | 'LENGTH_MISMATCH' // 总长与图纸不符
    | 'UNSUPPORTED_BEND_PLANE'
    | 'REDUCER_PARAM_MISSING'
    | 'TAG_DUPLICATE';
  message: string;
}
