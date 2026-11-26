/**
 * 演示数据生成器（Node/tsx 运行，产物 public/demo-seed.json，首启灌入 IndexedDB）。
 * 一套常减压塔顶系统：初馏塔/常压塔/减压塔 三个单元 24 条管线，
 * 数千管件，4 期测厚，5 处弯头外弧局部减薄 + 1 处 C 扫描网格 + 坏行/可疑点。
 */
import {
  CScanGrid,
  Direction,
  Fitting,
  FittingKind,
  InspectionRound,
  Pipeline,
  ThicknessPoint,
  ThicknessReading,
  BadRow,
} from '../src/types';
import { lookupNominalWall, lookupOuterDiameter } from '../src/standards';
import { buildGeometry, bendSideTheta } from '../src/geometry/centerline';
import { placePoints } from '../src/geometry/placement';
import { clockToTheta, thetaToClock } from '../src/math/vector';

let seqCounter = 0;
const nextId = (p: string) => `${p}_${(seqCounter++).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

interface FitSpec {
  kind: FittingKind;
  tag: string;
  dir: Direction;
  length?: number;
  angle?: 45 | 90;
  lr?: 'LR' | 'SR';
  exitDir?: Direction;
  branchDir?: Direction;
  branchSpecs?: FitSpec[];
  branchDn?: number;
  outletDn?: number;
  eccentric?: number;
  erosion?: boolean;
}

interface LineTemplate {
  unit: string;
  subUnit: string;
  lineNo: string;
  service: string;
  dn: number;
  schedule: string;
  designP: number;
  opP: number;
  designT: number;
  opT: number;
  material: string;
  ca: number;
  fittings: FitSpec[];
  drawingTotalLength?: number;
  injectionAfter?: string; // 该 tag 之后的直管标注水冲刷
}

const DN_POOL = [50, 80, 100, 150, 200, 250, 300];

/** 变径取小一档的 DN */
function smallerDn(dn: number): number {
  const i = DN_POOL.indexOf(dn);
  return i > 0 ? DN_POOL[i - 1] : Math.max(15, dn - 25);
}

function makeFittings(t: LineTemplate): Fitting[] {
  const od = lookupOuterDiameter(t.dn)!;
  const wall = lookupNominalWall(t.dn, t.schedule)!;
  const out: Fitting[] = [];
  let seq = 0;
  const currentDiameter = new Map<string, number>(); // routeId -> 当前外径
  const currentDn = new Map<string, number>(); // routeId -> 当前公称直径

  function buildList(specs: FitSpec[], routeId: string) {
    for (const sp of specs) {
      const tag = `${t.lineNo}-${sp.tag}`;
      const base: Fitting = {
        id: nextId('fit'),
        pipelineId: t.lineNo,
        seq: seq++,
        kind: sp.kind,
        length: 0,
        direction: sp.dir,
        tag,
        routeId,
        erosionFocus: sp.erosion,
      };
      const curOd = currentDiameter.get(routeId) ?? od;
      const curDn = currentDn.get(routeId) ?? t.dn;
      switch (sp.kind) {
        case 'PIPE':
          base.length = sp.length ?? 2000;
          base.diameter = curOd;
          base.nominalDiameter = curDn;
          base.nominalWall = wall;
          break;
        case 'ELBOW': {
          const R = (sp.lr === 'SR' ? 1 : 1.5) * curDn;
          base.length = Math.round(R * ((sp.angle ?? 90) * Math.PI / 180) * 10) / 10;
          base.elbowAngle = sp.angle ?? 90;
          base.elbowRadiusType = sp.lr ?? 'LR';
          base.bendRadius = R;
          base.nominalDiameter = curDn;
          base.exitDirection = sp.exitDir;
          base.diameter = curOd;
          base.nominalWall = wall;
          break;
        }
        case 'TEE':
          base.length = curOd * 1.2;
          base.branchDirection = sp.branchDir;
          base.branchDiameter = sp.branchDn ? lookupOuterDiameter(sp.branchDn) : curOd;
          base.diameter = curOd;
          base.nominalDiameter = curDn;
          base.nominalWall = wall;
          break;
        case 'REDUCER': {
          const targetDn = sp.outletDn && sp.outletDn > 0 ? sp.outletDn : smallerDn(curDn);
          const outOd = lookupOuterDiameter(targetDn)!;
          base.length = Math.max(150, (curOd - outOd) * 1.5 + 100);
          base.outletDiameter = outOd;
          base.reducerType = sp.eccentric ? 'ECCENTRIC' : 'CONCENTRIC';
          base.eccentricOffset = sp.eccentric;
          base.diameter = curOd;
          base.nominalDiameter = curDn;
          base.nominalWall = wall;
          currentDiameter.set(routeId, outOd);
          currentDn.set(routeId, targetDn);
          break;
        }
        case 'FLANGE':
          base.length = curOd * 0.35 + 18;
          base.diameter = curOd;
          base.nominalDiameter = curDn;
          base.nominalWall = wall;
          break;
        case 'VALVE':
          base.length = curOd * 0.9 + 60;
          base.diameter = curOd;
          base.nominalDiameter = curDn;
          base.nominalWall = wall;
          break;
      }
      out.push(base);
      if (sp.kind === 'TEE' && sp.branchSpecs) {
        buildList(sp.branchSpecs, base.id);
      }
    }
  }
  buildList(t.fittings, 'main');
  return out;
}

/** 塔顶挥发线典型走向：塔顶垂直上升 → 水平 → 空冷/回流罐，带三通支线 */
function overheadLine(variant: number): FitSpec[] {
  const flip = variant % 2 === 0 ? 1 : -1;
  const z: Direction = flip > 0 ? '+Z' : '-Z';
  const x: Direction = flip > 0 ? '+X' : '-X';
  return [
    { kind: 'FLANGE', tag: 'F01', dir: '+Y' },
    { kind: 'PIPE', tag: 'P01', dir: '+Y', length: 3500 },
    { kind: 'ELBOW', tag: 'E01', dir: '+Y', angle: 90, exitDir: x },
    { kind: 'PIPE', tag: 'P02', dir: x, length: 4200, erosion: true },
    { kind: 'ELBOW', tag: 'E02', dir: x, angle: 90, exitDir: '-Y' },
    { kind: 'PIPE', tag: 'P03', dir: '-Y', length: 1800 },
    {
      kind: 'TEE', tag: 'T01', dir: '-Y', branchDir: z,
      branchSpecs: [
        { kind: 'PIPE', tag: 'BP1', dir: z, length: 2600 },
        { kind: 'ELBOW', tag: 'BE1', dir: z, angle: 90, exitDir: '-Y' },
        { kind: 'PIPE', tag: 'BP2', dir: '-Y', length: 1500 },
        { kind: 'VALVE', tag: 'BV1', dir: '-Y' },
        { kind: 'FLANGE', tag: 'BF1', dir: '-Y' },
      ],
    },
    { kind: 'PIPE', tag: 'P04', dir: '-Y', length: 2400 },
    { kind: 'REDUCER', tag: 'R01', dir: '-Y', outletDn: 0 },
    { kind: 'ELBOW', tag: 'E03', dir: '-Y', angle: 45, exitDir: z },
    { kind: 'PIPE', tag: 'P05', dir: z, length: 1200 },
    { kind: 'VALVE', tag: 'V01', dir: z },
    { kind: 'FLANGE', tag: 'F02', dir: z },
  ];
}

function simpleLine(dir: Direction, withTee = false, withReducer = false): FitSpec[] {
  const opp: Direction = dir === '+X' ? '-X' : dir === '-X' ? '+X' : dir === '+Z' ? '-Z' : '+Z';
  const list: FitSpec[] = [
    { kind: 'FLANGE', tag: 'F01', dir },
    { kind: 'PIPE', tag: 'P01', dir, length: 3000 + Math.floor(Math.random() * 1500) },
    { kind: 'ELBOW', tag: 'E01', dir, angle: 90, exitDir: '+Y' },
    { kind: 'PIPE', tag: 'P02', dir: '+Y', length: 2000 },
    { kind: 'ELBOW', tag: 'E02', dir: '+Y', angle: 90, exitDir: opp },
  ];
  if (withTee) {
    list.push({
      kind: 'TEE', tag: 'T01', dir: opp, branchDir: '-Y',
      branchSpecs: [
        { kind: 'PIPE', tag: 'BP1', dir: '-Y', length: 1200 },
        { kind: 'VALVE', tag: 'BV1', dir: '-Y' },
      ],
    });
  }
  list.push({ kind: 'PIPE', tag: 'P03', dir: opp, length: 2500 });
  if (withReducer) {
    list.push({ kind: 'REDUCER', tag: 'R01', dir: opp, outletDn: 0 });
  }
  list.push(
    { kind: 'ELBOW', tag: 'E03', dir: opp, angle: 45, exitDir: '-Y' },
    { kind: 'PIPE', tag: 'P04', dir: '-Y', length: 900 },
    { kind: 'FLANGE', tag: 'F02', dir: '-Y' },
  );
  return list;
}

/** 长距离跨框架走向：多次抬升/转向，阀门法兰齐全，管件数 20+ */
function longRackLine(variant: number): FitSpec[] {
  const a: Direction = variant % 2 ? '+X' : '+Z';
  const b: Direction = a === '+X' ? '+Z' : '+X';
  const na: Direction = a === '+X' ? '-X' : '-Z';
  return [
    { kind: 'FLANGE', tag: 'F01', dir: a },
    { kind: 'PIPE', tag: 'P01', dir: a, length: 4000 },
    { kind: 'VALVE', tag: 'V01', dir: a },
    { kind: 'PIPE', tag: 'P02', dir: a, length: 3000 },
    { kind: 'ELBOW', tag: 'E01', dir: a, angle: 90, exitDir: '+Y' },
    { kind: 'PIPE', tag: 'P03', dir: '+Y', length: 2600 },
    { kind: 'ELBOW', tag: 'E02', dir: '+Y', angle: 90, exitDir: b },
    { kind: 'PIPE', tag: 'P04', dir: b, length: 5000 },
    { kind: 'ELBOW', tag: 'E03', dir: b, angle: 45, exitDir: '+Y' },
    { kind: 'PIPE', tag: 'P05', dir: '+Y', length: 1400 },
    { kind: 'ELBOW', tag: 'E04', dir: '+Y', angle: 45, exitDir: b },
    { kind: 'PIPE', tag: 'P06', dir: b, length: 3200 },
    {
      kind: 'TEE', tag: 'T01', dir: b, branchDir: '-Y',
      branchSpecs: [
        { kind: 'PIPE', tag: 'BP1', dir: '-Y', length: 1800 },
        { kind: 'ELBOW', tag: 'BE1', dir: '-Y', angle: 90, exitDir: na },
        { kind: 'PIPE', tag: 'BP2', dir: na, length: 1500 },
        { kind: 'VALVE', tag: 'BV1', dir: na },
        { kind: 'FLANGE', tag: 'BF1', dir: na },
      ],
    },
    { kind: 'PIPE', tag: 'P07', dir: b, length: 2800 },
    { kind: 'ELBOW', tag: 'E06', dir: b, angle: 90, exitDir: '+Y' },
    { kind: 'PIPE', tag: 'P07B', dir: '+Y', length: 1800 },
    { kind: 'ELBOW', tag: 'E07', dir: '+Y', angle: 90, exitDir: b },
    { kind: 'PIPE', tag: 'P07C', dir: b, length: 2200 },
    { kind: 'REDUCER', tag: 'R01', dir: b, outletDn: 0 },
    { kind: 'PIPE', tag: 'P08', dir: b, length: 1600 },
    { kind: 'ELBOW', tag: 'E05', dir: b, angle: 90, exitDir: '-Y' },
    { kind: 'PIPE', tag: 'P09', dir: '-Y', length: 1200 },
    { kind: 'FLANGE', tag: 'F02', dir: '-Y' },
  ];
}

const UNITS = [
  { unit: '常减压装置', sub: '初馏塔顶系统', prefix: 'PV' },
  { unit: '常减压装置', sub: '常压塔顶系统', prefix: 'HV' },
  { unit: '常减压装置', sub: '减压塔顶系统', prefix: 'VV' },
];

const SERVICES = [
  '塔顶油气', '塔顶瓦斯', '挥发线冷凝液', '回流油', '酸性水',
  '注水混合流', '空冷入口油气', '塔顶不凝气',
];
const MATERIALS = ['20#', '20G', 'Q245R', '15CrMoG'];

function buildTemplates(): LineTemplate[] {
  const templates: LineTemplate[] = [];
  let n = 0;
  for (let u = 0; u < UNITS.length; u++) {
    const count = u === 1 ? 14 : 12; // 38 条
    for (let i = 0; i < count; i++) {
      n++;
      const dn = DN_POOL[(n + i) % DN_POOL.length];
      const schedule = dn >= 200 ? 'SCH20' : 'SCH40';
      const isOverhead = i < 2;
      const isLong = i % 3 === 2;
      const lineNo = `${UNITS[u].prefix}-${1000 + n}-${dn}-${schedule}`;
      const t: LineTemplate = {
        unit: UNITS[u].unit,
        subUnit: UNITS[u].sub,
        lineNo,
        service: SERVICES[(n + i) % SERVICES.length],
        dn,
        schedule,
        designP: +(0.35 + (n % 5) * 0.12).toFixed(2),
        opP: +(0.18 + (n % 4) * 0.08).toFixed(2),
        designT: [180, 220, 380][u] + (i % 3) * 15,
        opT: [150, 190, 330][u] + (i % 3) * 10,
        material: MATERIALS[(n + u) % MATERIALS.length],
        ca: 1.5 + (n % 3) * 0.5,
        fittings: isOverhead
          ? overheadLine(n)
          : isLong
            ? longRackLine(n)
            : simpleLine(n % 2 === 0 ? '+X' : '+Z', i % 2 === 0, i % 3 === 0),
      };
      if (isOverhead) t.injectionAfter = 'E01';
      templates.push(t);
    }
  }
  return templates;
}

// ---------- 测点布置 ----------
function makePoints(pipeline: Pipeline, fittings: Fitting[], geo: ReturnType<typeof buildGeometry>): ThicknessPoint[] {
  const pts: ThicknessPoint[] = [];
  const roundClock = (theta: number) => Math.round(thetaToClock(theta) * 10) / 10;
  for (const f of fittings) {
    const add = (axial: number, clock: number, bendSide: ThicknessPoint['bendSide'], suffix: string) => {
      pts.push({
        id: nextId('pt'),
        pipelineId: pipeline.id,
        fittingId: f.id,
        pointNo: `${f.tag}-T${suffix}`,
        axialDistance: Math.round(axial * 10) / 10,
        clock,
        bendSide,
      });
    };
    if (f.kind === 'ELBOW') {
      const dom = geo.domainByFitting.get(f.id)!;
      // 内弧、侧弧布点（外弧故意只在部分弯头上布置——复现"全打在内弧"的盲区）
      const sMid = dom.length * 0.5;
      add(sMid, roundClock(bendSideTheta(dom, sMid, 'INTRADOS')), 'INTRADOS', '01');
      add(dom.length * 0.25, 3, 'SIDE', '02');
      add(dom.length * 0.75, 9, 'SIDE', '03');
    } else if (f.kind === 'TEE') {
      add(f.length / 2, 12, 'NONE', '01');
      add(f.length / 2, 6, 'NONE', '02');
    } else if (f.kind === 'PIPE' && f.length > 1500) {
      add(Math.min(300, f.length * 0.2), 12, 'NONE', '01');
      add(f.length * 0.5, 3, 'NONE', '02');
      add(f.length * 0.5, 6, 'NONE', '03');
      add(Math.max(f.length - 300, f.length * 0.8), 12, 'NONE', '04');
    } else if (f.kind === 'REDUCER' || f.kind === 'VALVE') {
      add(f.length * 0.5, 12, 'NONE', '01');
    }
  }
  return pts;
}

// ---------- 测厚读数 ----------
const ROUND_DATES = [
  { name: '2022-大修', date: Date.UTC(2022, 3, 12) },
  { name: '2023-大修', date: Date.UTC(2023, 3, 18) },
  { name: '2024-中修', date: Date.UTC(2024, 8, 5) },
  { name: '2025-大修', date: Date.UTC(2025, 3, 22) },
];

interface ThinningSpot {
  lineNo: string;
  elbowTag: string; // 局部减薄弯头
  sFrac: number; // 弧向位置
  theta: number; // 外弧 θ
  depthRate: number; // mm/a 减薄速率
  radiusMm: number; // 冲刷坑表面半径
}

function pickThinningSpots(templates: LineTemplate[]): ThinningSpot[] {
  const spots: ThinningSpot[] = [];
  const overheads = templates.filter((t) => t.fittings.some((f) => f.tag.endsWith('E02')));
  const chosen = overheads.slice(0, 5);
  chosen.forEach((t, i) => {
    const fittings = makeFittings(t);
    const geo = buildGeometry(makePipeline(t), fittings);
    const elbow = fittings.find((f) => f.tag.endsWith('E02'))!;
    const dom = geo.domainByFitting.get(elbow.id)!;
    const theta = bendSideTheta(dom, dom.length * (0.35 + i * 0.08), 'EXTRADOS');
    spots.push({
      lineNo: t.lineNo,
      elbowTag: elbow.tag,
      sFrac: 0.35 + i * 0.08,
      theta,
      depthRate: 0.55 + i * 0.06,
      radiusMm: t.dn * 0.45,
    });
  });
  return spots;
}

function makePipeline(t: LineTemplate): Pipeline {
  const od = lookupOuterDiameter(t.dn)!;
  const wall = lookupNominalWall(t.dn, t.schedule)!;
  return {
    id: t.lineNo,
    unit: t.unit,
    subUnit: t.subUnit,
    lineNo: t.lineNo,
    service: t.service,
    designPressure: t.designP,
    operatingPressure: t.opP,
    designTemp: t.designT,
    operatingTemp: t.opT,
    material: t.material,
    corrosionAllowance: t.ca,
    nominalDiameter: t.dn,
    wallSchedule: t.schedule,
    outerDiameter: od,
    nominalWall: wall,
    weldJointEfficiency: 1,
    createdAt: Date.UTC(2022, 0, 1),
    updatedAt: Date.UTC(2022, 0, 1),
  };
}

// ---------- 测厚读数 ----------
export interface SeedBundle {
  pipelines: Pipeline[];
  fittings: Fitting[];
  points: ThicknessPoint[];
  rounds: InspectionRound[];
  readings: ThicknessReading[];
  badRows: BadRow[];
  cscans: CScanGrid[];
  thinningSpots: ThinningSpot[];
}

function gauss(d: number, radius: number): number {
  return Math.exp(-(d * d) / (2 * (radius / 2) * (radius / 2)));
}

export function generateSeed(): SeedBundle {
  seqCounter = 0;
  const templates = buildTemplates();
  const pipelines: Pipeline[] = [];
  const allFittings: Fitting[] = [];
  const allPoints: ThicknessPoint[] = [];
  const rounds: InspectionRound[] = ROUND_DATES.map((r) => ({
    id: `R${r.date}`,
    name: r.name,
    inspectDate: r.date,
  }));
  const readings: ThicknessReading[] = [];
  const badRows: BadRow[] = [];
  const cscans: CScanGrid[] = [];
  const spots = pickThinningSpots(templates);

  templates.forEach((t, ti) => {
    const pipeline = makePipeline(t);
    if (t.injectionAfter) {
      pipeline.injectionDownstreamTags = [`${t.lineNo}-P02`];
    }
    pipelines.push(pipeline);
    const fittings = makeFittings(t);
    allFittings.push(...fittings);
    const geo = buildGeometry(pipeline, fittings);
    const points = makePoints(pipeline, fittings, geo);
    allPoints.push(...points);

    const placed = placePoints(geo, points);
    if (placed.errors.length) {
      console.warn(`[seed] ${t.lineNo} 落点错误:`, placed.errors.map((e) => e.message));
    }
    const param = placed.paramsByPoint;
    const spot = spots.find((s) => s.lineNo === t.lineNo);
    const spotFitting = spot ? fittings.find((f) => f.tag === spot.elbowTag) : undefined;
    const spotDom = spotFitting ? geo.domainByFitting.get(spotFitting.id) : undefined;
    // 每条管线一个基础腐蚀速率 0.08~0.22 mm/a
    const baseRate = 0.08 + ((ti * 37) % 14) / 100;
    const year0 = ROUND_DATES[0].date;

    for (const pt of points) {
      const p = param.get(pt.id)!;
      const dom = geo.domainByFitting.get(p.domainId)!;
      for (let ri = 0; ri < rounds.length; ri++) {
        const years = (rounds[ri].inspectDate - year0) / (365.25 * 864e5);
        let rate = baseRate;
        // 外弧局部减薄：按表面距离给高斯坑（内弧点不受影响——距离半个圆周）
        if (spot && spotFitting && dom.fittingId === spotFitting.id) {
          let dTheta = Math.abs(p.theta - spot.theta);
          dTheta = Math.min(dTheta, 2 * Math.PI - dTheta);
          const surfaceDist = Math.sqrt(
            (p.s - spot.sFrac * dom.length) ** 2 + ((dom.diameter / 2) * dTheta) ** 2,
          );
          rate += spot.depthRate * gauss(surfaceDist, spot.radiusMm);
        }
        // 测量噪声 ±0.04mm
        const noise = (Math.sin(ti * 13 + ri * 7 + points.indexOf(pt) * 3) * 0.04);
        let thickness = pipeline.nominalWall - rate * years + noise;
        thickness = Math.round(thickness * 1000) / 1000;

        // 埋可疑点：第 3 期起每条管第一个侧弧点 T02 读数锁定在第 2 期水平并抬高 0.25mm，
        // 后续期次不再随腐蚀下降 —— 两期对比必然出现超测量误差的增厚，
        // diff 模块必须把它标出来且寿命评估不拿它算速率
        const isSuspiciousPoint = pt.pointNo.endsWith('T02')
          && pt.pointNo === points.find((x) => x.pointNo.endsWith('T02'))?.pointNo;
        const suspicious = ri >= 2 && isSuspiciousPoint;
        if (suspicious) {
          // 第 2 期同点厚度为基准，第 3 期抬高 0.25，第 4 期再抬一点，
          // 保证任意相邻两期对比都出现超测量误差(0.1mm)的正差
          const baseYears = (rounds[1].inspectDate - year0) / (365.25 * 864e5);
          const baseThk = pipeline.nominalWall - rate * baseYears;
          const bump = ri === 2 ? 0.25 : 0.45;
          thickness = +(baseThk + bump).toFixed(3);
        }

        readings.push({
          id: nextId('rd'),
          roundId: rounds[ri].id,
          pointNo: pt.pointNo,
          pipelineId: t.lineNo,
          thickness,
        });
      }
    }

    // C 扫描：给第一条减薄线的 E02 弯头铺 8(轴向)×12(周向) 网格
    if (spot && spotFitting && ti === spots.findIndex((s) => s.lineNo === spots[0].lineNo)) {
      const rows = 8;
      const cols = 12;
      const values: number[] = [];
      const axialStep = spotDom!.length / (rows + 1);
      const clockStep = 12 / cols;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const s = axialStep * (r + 1);
          const theta = clockToTheta(1 + c * clockStep);
          let dTheta = Math.abs(theta - spot.theta);
          dTheta = Math.min(dTheta, 2 * Math.PI - dTheta);
          const d = Math.sqrt(
            (s - spot.sFrac * spotDom!.length) ** 2 + ((spotDom!.diameter / 2) * dTheta) ** 2,
          );
          const years = (ROUND_DATES[3].date - year0) / (365.25 * 864e5);
          const rate = baseRate + spot.depthRate * gauss(d, spot.radiusMm);
          values.push(+(pipeline.nominalWall - rate * years).toFixed(3));
        }
      }
      cscans.push({
        id: nextId('cs'),
        roundId: rounds[3].id,
        fittingId: spotFitting.id,
        pointNoBase: spotFitting.tag,
        axialStart: axialStep,
        axialStep,
        clockStart: 1,
        clockStep,
        rows,
        cols,
        values,
      });
    }
  });

  // ---------- 坏行 ----------
  const round3 = rounds[2].id;
  const somePoint = allPoints[Math.floor(allPoints.length * 0.3)];
  const nominal = pipelines.find((p) => p.id === somePoint.pipelineId)!.nominalWall;
  badRows.push(
    { id: nextId('bad'), roundId: round3, source: 'CSV', rowIndex: 12, raw: `${somePoint.pointNo},9.99`, reason: 'THICKNESS_EXCEEDS_NOMINAL', detail: `读数 9.99mm 大于名义壁厚 ${nominal}mm` },
    { id: nextId('bad'), roundId: round3, source: 'CSV', rowIndex: 37, raw: `${allPoints[5].pointNo},0.25`, reason: 'BAD_UNIT_INCH', detail: '疑似单位填成英寸' },
    { id: nextId('bad'), roundId: round3, source: 'CSV', rowIndex: 58, raw: 'GHOST-999-T01,5.21', reason: 'POINT_NOT_FOUND', detail: '点号 GHOST-999-T01 不存在' },
    { id: nextId('bad'), roundId: round3, source: 'CSV', rowIndex: 81, raw: `${allPoints[20].pointNo},N/A`, reason: 'PARSE_ERROR', detail: '厚度无法解析' },
  );

  return { pipelines, fittings: allFittings, points: allPoints, rounds, readings, badRows, cscans, thinningSpots: spots };
}
