import type {
  BadRow,
  CScanGrid,
  Fitting,
  InspectionPeriod,
  Pipeline,
  Reading,
  ThicknessPoint
} from '../domain/types'
import { lookupOd, lookupWall, MATERIAL_STRESS } from '../domain/tables'
import { resolveLine, type ResolvedLine } from '../domain/geometry'
import { radialToClock, rotateAround } from '../domain/vec'
import { computeSuspicious } from '../domain/analysis'

// 确定性随机，保证每次重置得到同一套演示数据
function mulberry32(seed: number) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const SEED_VERSION = 'v10-2026-11-27-timebase'

export const PERIODS: InspectionPeriod[] = [
  { id: 'per-2022', name: '2022 例行测厚', date: '2022-05-16', order: 0 },
  { id: 'per-2023', name: '2023 大修', date: '2023-04-20', order: 1 },
  { id: 'per-2025', name: '2025 大修', date: '2025-04-12', order: 2 },
  { id: 'per-2026', name: '2026 泄漏后加测/C扫', date: '2026-09-08', order: 3 }
]

// 厚度场使用的累计腐蚀年数，严格由各期实际日期相对首期推算，
// 保证"生成时的速率"与 API570 反算速率同口径。
const SEED_T0 = new Date(PERIODS[0].date).getTime()
const MODEL_YEARS = PERIODS.map((p) => (new Date(p.date).getTime() - SEED_T0) / (365.25 * 86400000))

interface PipeSpec {
  code: string
  block: string
  medium: string
  dn: number
  sch: string
  material: string
  P: number
  T: number
  ca: number
  cycle?: number
}

// 一套常减压装置塔顶（挥发线/冷凝/注水/缓蚀剂/产品）系统
const SPECS: PipeSpec[] = [
  { code: 'CDU-OH-2001', block: '常压塔顶', medium: '塔顶油气(HCl+H2S+H2O)', dn: 700, sch: 'Sch20', material: '20#', P: 0.35, T: 135, ca: 4 },
  { code: 'CDU-OH-2002', block: '常压塔顶', medium: '塔顶挥发线', dn: 800, sch: 'Sch20', material: '20#', P: 0.32, T: 130, ca: 4 },
  { code: 'CDU-OH-2003', block: '常压塔顶', medium: '常顶油气-空冷', dn: 600, sch: 'Sch20', material: '20#', P: 0.3, T: 120, ca: 3 },
  { code: 'CDU-OH-2004', block: '常压塔顶', medium: '常顶油气-水冷', dn: 500, sch: 'STD', material: '20#', P: 0.28, T: 95, ca: 3 },
  { code: 'CDU-OV-2101', block: '初馏塔顶', medium: '初顶油气', dn: 500, sch: 'STD', material: '20#', P: 0.38, T: 145, ca: 3 },
  { code: 'CDU-OV-2102', block: '初馏塔顶', medium: '初顶挥发线', dn: 450, sch: 'STD', material: '20#', P: 0.36, T: 140, ca: 3 },
  { code: 'VDU-EJ-3001', block: '减压塔顶', medium: '减顶油气/不凝气', dn: 900, sch: 'Sch20', material: 'Q245R', P: 0.12, T: 90, ca: 3 },
  { code: 'VDU-EJ-3002', block: '减压塔顶', medium: '抽真空系统挥发线', dn: 600, sch: 'Sch20', material: '20#', P: 0.1, T: 80, ca: 3 },
  { code: 'VDU-EJ-3003', block: '减压塔顶', medium: '减顶瓦斯', dn: 350, sch: 'STD', material: '20#', P: 0.18, T: 70, ca: 2.5 },
  { code: 'CDU-AC-4101', block: '塔顶冷凝冷却', medium: '常顶冷凝油', dn: 400, sch: 'Sch40', material: '20#', P: 1.2, T: 60, ca: 3 },
  { code: 'CDU-AC-4102', block: '塔顶冷凝冷却', medium: '常顶回流油', dn: 300, sch: 'Sch40', material: '20#', P: 1.4, T: 55, ca: 2 },
  { code: 'CDU-AC-4103', block: '塔顶冷凝冷却', medium: '初顶冷凝油', dn: 300, sch: 'Sch40', material: '20#', P: 1.1, T: 65, ca: 2.5 },
  { code: 'CDU-AC-4104', block: '塔顶冷凝冷却', medium: '减顶冷凝油', dn: 250, sch: 'Sch40', material: '20#', P: 1.0, T: 50, ca: 2 },
  { code: 'CDU-RF-4201', block: '塔顶回流', medium: '常顶冷回流', dn: 250, sch: 'Sch40', material: '20#', P: 1.6, T: 45, ca: 2 },
  { code: 'CDU-RF-4202', block: '塔顶回流', medium: '常顶循环回流', dn: 350, sch: 'Sch40', material: '20#', P: 1.5, T: 120, ca: 2.5 },
  { code: 'CDU-RF-4203', block: '塔顶回流', medium: '初顶回流', dn: 200, sch: 'Sch80', material: '20#', P: 1.7, T: 40, ca: 2 },
  { code: 'INJ-W-5001', block: '注水系统', medium: '塔顶注水(含HCl)', dn: 80, sch: 'Sch80', material: '316L', P: 4.0, T: 40, ca: 1.5 },
  { code: 'INJ-W-5002', block: '注水系统', medium: '常顶注水管', dn: 100, sch: 'Sch80', material: '20#', P: 3.6, T: 40, ca: 3 },
  { code: 'INJ-C-5101', block: '缓蚀剂系统', medium: '缓蚀剂注入', dn: 50, sch: 'Sch160', material: '316L', P: 5.0, T: 35, ca: 1 },
  { code: 'INJ-N-5102', block: '缓蚀剂系统', medium: '中和胺注入', dn: 40, sch: 'Sch160', material: '316L', P: 5.0, T: 35, ca: 1 },
  { code: 'CDU-PD-6001', block: '塔顶产品', medium: '常顶石脑油', dn: 250, sch: 'Sch40', material: '20#', P: 1.0, T: 50, ca: 2 },
  { code: 'CDU-PD-6002', block: '塔顶产品', medium: '初顶石脑油', dn: 200, sch: 'Sch40', material: '20#', P: 1.0, T: 55, ca: 2 },
  { code: 'CDU-PD-6003', block: '塔顶产品', medium: '塔顶瓦斯', dn: 300, sch: 'Sch40', material: '20#', P: 0.5, T: 45, ca: 2 },
  { code: 'CDU-BP-7001', block: '旁路/跨线', medium: '油气跨线', dn: 450, sch: 'STD', material: '20G', P: 0.4, T: 150, ca: 3 },
  { code: 'CDU-BP-7002', block: '旁路/跨线', medium: '开工循环线', dn: 350, sch: 'STD', material: '20#', P: 0.6, T: 160, ca: 3 },
  { code: 'CDU-DR-8001', block: '塔顶排凝', medium: '含硫污水排凝', dn: 100, sch: 'Sch80', material: '20#', P: 0.8, T: 60, ca: 4 },
  { code: 'CDU-DR-8002', block: '塔顶排凝', medium: '回流罐切水', dn: 150, sch: 'Sch80', material: '20#', P: 0.7, T: 55, ca: 4 }
]

type Axis = [number, number, number]
const AXES: Axis[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1]
]

interface HotspotSpec {
  line: number
  elbowOrdinal: number
  sFrac: number
  spreadS: number
  spreadPsi: number
  /** 各期累计局部减薄量 mm（叠加在普遍腐蚀之上） */
  loss: number[]
}

// 埋设的若干处弯头外弧局部减薄；第 0 处即故事主角
const HOTSPOTS: HotspotSpec[] = [
  { line: 0, elbowOrdinal: 3, sFrac: 0.55, spreadS: 150, spreadPsi: 0.32, loss: [0.2, 0.5, 1.1, 5.0] },
  { line: 1, elbowOrdinal: 5, sFrac: 0.5, spreadS: 200, spreadPsi: 0.4, loss: [0.2, 0.5, 1.0, 2.6] },
  { line: 2, elbowOrdinal: 2, sFrac: 0.6, spreadS: 160, spreadPsi: 0.35, loss: [0.15, 0.4, 0.8, 2.2] },
  { line: 4, elbowOrdinal: 4, sFrac: 0.5, spreadS: 120, spreadPsi: 0.4, loss: [0.2, 0.6, 1.2, 2.9] },
  { line: 6, elbowOrdinal: 6, sFrac: 0.5, spreadS: 260, spreadPsi: 0.45, loss: [0.15, 0.35, 0.7, 1.9] },
  { line: 16, elbowOrdinal: 1, sFrac: 0.5, spreadS: 60, spreadPsi: 0.5, loss: [0.3, 0.9, 1.8, 4.1] },
  { line: 26, elbowOrdinal: 2, sFrac: 0.5, spreadS: 90, spreadPsi: 0.45, loss: [0.4, 1.1, 2.2, 4.5] }
]

export interface SeedResult {
  pipelines: Pipeline[]
  fittings: Fitting[]
  points: ThicknessPoint[]
  readings: Reading[]
  periods: InspectionPeriod[]
  cscans: CScanGrid[]
  badrows: BadRow[]
  resolved: ResolvedLine[]
}

export function generateSeed(): SeedResult {
  const rng = mulberry32(20261127)
  const pipelines: Pipeline[] = []
  const fittings: Fitting[] = []
  const points: ThicknessPoint[] = []
  const readings: Reading[] = []
  const cscans: CScanGrid[] = []
  const badrows: BadRow[] = []

  let fittingSeqGlobal = 0
  let pointSeqGlobal = 0
  let readingSeqGlobal = 0
  let cscanSeqGlobal = 0

  const rand = (a: number, b: number) => a + rng() * (b - a)
  const pick = <T,>(arr: T[]) => arr[Math.floor(rng() * arr.length)]

  SPECS.forEach((spec, li) => {
    const od = lookupOd(spec.dn)
    const wall = lookupWall(spec.dn, spec.sch) ?? spec.dn * 0.012
    const ms = MATERIAL_STRESS[spec.material] ?? MATERIAL_STRESS['20#']
    const pl: Pipeline = {
      id: `pl-${li + 1}`,
      code: spec.code,
      unit: '常减压装置',
      block: spec.block,
      medium: spec.medium,
      opTempC: spec.T,
      opPressureMPa: +(spec.P * 0.7).toFixed(2),
      designPressureMPa: spec.P,
      material: spec.material,
      allowableStressMPa: ms.S,
      weldEfficiency: ms.E,
      corrosionAllowanceMm: spec.ca,
      dn: spec.dn,
      schedule: spec.sch,
      outerDiameterMm: od,
      nominalWallMm: +wall.toFixed(2),
      inspectionCycleYears: spec.cycle ?? 3,
      drawingTotalLengthM: 0, // 生成后回填，保证与模型一致
      note: li === 0 ? '塔顶挥发线关键管线；2025 大修外弧漏检，开车 3 个月后弯头泄漏' : undefined
    }
    pipelines.push(pl)

    // ---- 生成走向 ----
    const lineFits: Fitting[] = []
    let seq = 1
    const pushF = (kind: Fitting['kind'], dir: Axis, lengthMm: number, extra: Partial<Fitting> = {}) => {
      const f: Fitting = {
        id: `ft-${++fittingSeqGlobal}`,
        pipelineId: pl.id,
        seq: seq++,
        code: `${spec.code}-F${String(seq - 1).padStart(3, '0')}`,
        kind,
        dir: [...dir] as Axis,
        lengthMm: Math.round(lengthMm),
        ...extra
      }
      lineFits.push(f)
      return f
    }

    // 根部：法兰 + 阀门 + 法兰
    let dir: Axis = [1, 0, 0]
    pushF('flange', dir, 0)
    pushF('valve_gate', dir, 0)
    pushF('flange', dir, 0)

    const targetCount = Math.round(rand(108, 138))
    let elbowOrdinal = -1
    const elbowIds: string[] = []
    let sinceTurn = 0

    while (lineFits.length < targetCount) {
      // 一段直管（可能 1~2 个管段）
      const spools = rng() < 0.3 ? 2 : 1
      for (let k = 0; k < spools && lineFits.length < targetCount; k++) {
        pushF('pipe', dir, rand(700, 2600))
        sinceTurn++
        if (rng() < 0.18 && lineFits.length < targetCount - 2) pushF('flange', dir, 0)
      }
      // 偶发大小头 / 三通 / 阀门 / 注水点
      const roll = rng()
      if (roll < 0.12 && lineFits.length < targetCount - 2) {
        const dn2 = Math.max(40, Math.round(spec.dn * pick([0.5, 0.6, 0.75])! / 10) * 10)
        pushF(rng() < 0.5 ? 'reducer_conc' : 'reducer_ecc', dir, rand(180, 360), {
          dn2,
          outerDiameter2Mm: lookupOd(dn2),
          eccSide: pick(['top', 'bottom'])
        })
      } else if (roll < 0.24 && lineFits.length < targetCount - 2) {
        pushF('tee', dir, Math.max(200, spec.dn * 0.9))
      } else if (roll < 0.34 && lineFits.length < targetCount - 2) {
        pushF(pick(['valve_gate', 'valve_ball', 'valve_check']) as Fitting['kind'], dir, 0)
      }

      if (lineFits.length >= targetCount) break

      // 每 2~4 段转一次向，选与当前方向垂直的主轴
      if (sinceTurn >= 2 || rng() < 0.3) {
        const perp = AXES.filter((a) => Math.abs(a[0] * dir[0] + a[1] * dir[1] + a[2] * dir[2]) < 0.5)
        // 竖直方向权重低一些，避免过度上下
        const weighted = perp.filter((a) => a[1] !== 0).length && rng() < 0.35 ? perp.filter((a) => a[1] !== 0) : perp.filter((a) => a[1] === 0)
        const choices = weighted.length ? weighted : perp
        const nd = pick(choices)
        const kind: Fitting['kind'] = rng() < 0.15 ? 'elbow_sr' : 'elbow_lr'
        const e = pushF(kind, nd as Axis, 0)
        elbowOrdinal++
        elbowIds.push(e.id)
        dir = nd as Axis
        sinceTurn = 0
      }
    }
    // 末端盲端/法兰
    pushF('flange', dir, 0)
    if (rng() < 0.5) pushF('cap', dir, 0)

    fittings.push(...lineFits)

    // 解析本线几何
    const line = resolveLine(pl, lineFits)
    pl.drawingTotalLengthM = +(line.totalLengthMm / 1000).toFixed(2)

    // 本线热点
    const hotspots = HOTSPOTS.filter((h) => h.line === li)

    // 每个测点固定的腐蚀剖面（制造负偏差 + 普遍速率只抽一次，保证各期轨迹自洽）
    const drawProfile = (pointZone?: string) => {
      let rate = rand(0.05, 0.16) // 一般大气/油气环境的温和普遍腐蚀
      if (pointZone === 'elbow_outer') rate = rand(0.28, 0.6) // 弯头外弧冲刷
      else if (pointZone === 'tee_dead') rate = rand(0.3, 0.62) // 三通盲端冲蚀/沉积
      else if (pointZone === 'injection_downstream') rate = rand(0.5, 0.95) // 注水点下游高速+酸性水
      else if (spec.material === '316L') rate = rand(0.02, 0.09)
      else if (spec.medium.includes('HCl') || spec.medium.includes('污水')) rate = rand(0.12, 0.28)
      return { offset: rand(0.15, 0.6), rate }
    }

    // 为每个测点生成"真实厚度场"
    const trueThickness = (
      rfIndex: number,
      s: number,
      psi: number,
      periodIdx: number,
      profile: { offset: number; rate: number }
    ): number => {
      const rf = line.items[rfIndex]
      let t = pl.nominalWallMm - profile.offset - profile.rate * MODEL_YEARS[periodIdx]
      // 热点局部减薄（表面高斯）
      for (const h of hotspots) {
        if (elbowIds[h.elbowOrdinal] !== rf.fitting.id) continue
        const hs = rf.length * h.sFrac
        const ds = (s - hs) / h.spreadS
        let dp = Math.abs(psi - 0) // 外弧 psi=0
        dp = Math.min(dp, Math.PI * 2 - dp)
        const g = Math.exp(-0.5 * (ds * ds + (dp / h.spreadPsi) ** 2))
        t -= h.loss[periodIdx] * g
      }
      return t
    }

    // ---- 生成测点 + 读数 ----
    const addPoint = (
      rfIndex: number,
      clock: number,
      axial: number,
      reference: ThicknessPoint['reference'],
      zone: ThicknessPoint['zone'],
      opts: { periods?: number[]; cscan?: boolean; codeSuffix?: string } = {}
    ): ThicknessPoint => {
      const rf = line.items[rfIndex]
      const pt: ThicknessPoint = {
        id: `pt-${++pointSeqGlobal}`,
        pipelineId: pl.id,
        fittingId: rf.fitting.id,
        code: `${spec.code}-T${String(pointSeqGlobal).slice(-4)}${opts.codeSuffix ?? ''}`,
        reference,
        axialDistanceMm: Math.round(axial),
        clock: +clock.toFixed(2),
        zone,
        arcSide: zone === 'elbow_outer' ? 'outer' : zone === 'elbow_inner' ? 'inner' : 'neutral',
        isCscan: opts.cscan,
        active: true
      }
      points.push(pt)
      const periodsToRead = opts.periods ?? [0, 1, 2, 3]
      // 定位以计算真实厚度
      const { s } = (() => {
        let ss = axial
        if (reference === 'downstream_weld' || reference === 'fitting_end') ss = rf.length - axial
        return { s: Math.max(0, Math.min(rf.length, ss)) }
      })()
      const psi = rf.clockToPsi(s, clock)
      const profile = drawProfile(zone)
      periodsToRead.forEach((pi) => {
        let tv = trueThickness(rfIndex, s, psi, pi, profile)
        tv += rand(-0.06, 0.06) // UT 重复测量噪声（较小，避免短期速率误报）
        tv = Math.max(0.4, Math.round(tv * 100) / 100)
        const period = PERIODS[pi]
        readings.push({
          id: `rd-${++readingSeqGlobal}`,
          pointId: pt.id,
          pipelineId: pl.id,
          periodId: period.id,
          date: period.date,
          thicknessMm: tv,
          source: 'seed'
        })
      })
      return pt
    }

    // 逐件布置测点
    line.items.forEach((rf, ii) => {
      const kind = rf.kind
      const isHotElbowOrd = (() => {
        const ord = elbowIds.indexOf(rf.fitting.id)
        return hotspots.find((h) => h.elbowOrdinal === ord)
      })()
      const elbowOrd = elbowIds.indexOf(rf.fitting.id)

      if (kind === 'pipe') {
        if (rng() < 0.82) {
          // 靠近上游焊口
          addPoint(ii, pick([0, 3, 6, 9]), rand(80, 250), 'upstream_weld', 'normal')
          if (rng() < 0.4) addPoint(ii, pick([0, 3, 6, 9]), rand(80, 250), 'downstream_weld', 'normal')
        }
        // 注水点下游加密
        if (rng() < 0.06 || spec.block === '注水系统') {
          addPoint(ii, 6, rand(200, 600), 'upstream_weld', 'injection_downstream')
        }
      } else if (kind.startsWith('elbow')) {
        const midS = rf.length * 0.5
        // 求外弧/内弧钟点
        const mid = rf.centerAt(midS)
        const qOut = (() => {
          const phi = midS / rf.bendRadius!
          return rotateAround([-rf.bendM![0], -rf.bendM![1], -rf.bendM![2]], rf.bendAxis!, phi)
        })()
        const outerClock = radialToClock(mid.t, qOut)
        const innerClock = (outerClock + 6) % 12
        const blindSpot = isHotElbowOrd || rng() < 0.4
        if (blindSpot) {
          // 历史测点全打在内弧（事故根因）：两个轴向截面 × 内弧附近 3 个钟点
          for (const frac of [0.3, 0.7]) {
            for (const off of [-1.2, 0, 1.2]) {
              addPoint(ii, (innerClock + off + 12) % 12, rf.length * frac, 'fitting_start', 'elbow_inner')
            }
          }
          if (isHotElbowOrd) {
            // 2026 泄漏后才补的外弧测点
            addPoint(ii, outerClock, rf.length * isHotElbowOrd.sFrac, 'fitting_start', 'elbow_outer', {
              periods: [3],
              codeSuffix: '-O'
            })
            // C 扫描网格
            buildCscan(pl, rf, ii, isHotElbowOrd, trueThickness, cscans, cscanSeqGlobal, () => ++cscanSeqGlobal)
          } else if (rng() < 0.3) {
            addPoint(ii, outerClock, midS, 'fitting_start', 'elbow_outer')
          }
        } else {
          // 正常弯头：内/外弧都有
          addPoint(ii, outerClock, rf.length * 0.35, 'fitting_start', 'elbow_outer')
          addPoint(ii, outerClock, rf.length * 0.7, 'fitting_start', 'elbow_outer')
          addPoint(ii, innerClock, rf.length * 0.5, 'fitting_start', 'elbow_inner')
          if (rng() < 0.5) addPoint(ii, (outerClock + 3) % 12, midS, 'fitting_start', 'normal')
        }
      } else if (kind === 'tee') {
        addPoint(ii, 3, rf.length * 0.25, 'fitting_start', 'normal')
        addPoint(ii, 9, rf.length * 0.75, 'fitting_start', 'normal')
        // 三通盲端（支管顶端）
        addPoint(ii, 0, rf.length, 'fitting_start', 'tee_dead')
      } else if (kind.startsWith('reducer')) {
        if (rng() < 0.7) addPoint(ii, 6, rf.length * 0.5, 'fitting_start', rng() < 0.5 ? 'elbow_outer' : 'normal')
      } else {
        // 法兰/阀门/盲端
        if (rng() < 0.45) addPoint(ii, pick([0, 3, 6, 9]), rf.length * 0.5, 'fitting_start', 'normal')
      }
    })
  })

  // 重新计算 C 扫描 id 计数的小辅助（上面闭包计数简化）
  function buildCscan(
    pl: Pipeline,
    rf: ResolvedLine['items'][number],
    _ii: number,
    h: HotspotSpec,
    trueThickness: (ii: number, s: number, psi: number, pi: number, profile: { offset: number; rate: number }) => number,
    cscans: CScanGrid[],
    _seq: number,
    nextId: () => number
  ) {
    const axialCount = 9
    const clockCount = 11 // 外弧 ±约2.5 钟点小时
    const axialStep = h.spreadS * 0.55
    const axialStart = rf.length * h.sFrac - ((axialCount - 1) * axialStep) / 2
    const clockStepHours = 0.5
    const clockStart = -((clockCount - 1) * clockStepHours) / 2
    const values: number[] = []
    // 外弧 psi=0；钟点偏移 -> psi 偏移（1 钟点小时 = π/6）。C 扫区域用稳定外弧剖面
    const cscanProfile = { offset: 0.35, rate: 0.38 }
    for (let ai = 0; ai < axialCount; ai++) {
      const s = axialStart + ai * axialStep
      for (let ci = 0; ci < clockCount; ci++) {
        const offHours = clockStart + ci * clockStepHours
        const psi = (offHours / 12) * Math.PI * 2 // 相对外弧，可为负；场函数内取 abs+wrap
        let v = trueThickness(_ii, s, psi, 3, cscanProfile)
        // C 扫分辨率更高、噪声略小且确定
        v += Math.sin(ai * 3.1 + ci * 1.7) * 0.06
        values.push(Math.max(0.4, Math.round(v * 100) / 100))
      }
    }
    const id = `cs-${nextId()}`
    cscans.push({
      id,
      pipelineId: pl.id,
      fittingId: rf.fitting.id,
      periodId: PERIODS[3].id,
      pointCode: `${pl.code}-CS`,
      axialStartMm: +axialStart.toFixed(1),
      axialStepMm: +axialStep.toFixed(1),
      axialCount,
      clockStart: +clockStart.toFixed(2),
      clockStepHours,
      clockCount,
      values
    })
  }

  // 人为注入若干"后一期反而厚出测量误差"的可疑读数（约 14 处）
  const multiReadPoints = points.filter((p) => {
    const rs = readings.filter((r) => r.pointId === p.id)
    return rs.length >= 3
  })
  for (let k = 0; k < 14 && multiReadPoints.length; k++) {
    const pt = multiReadPoints[(k * 337 + 53) % multiReadPoints.length]
    const rs = readings
      .filter((r) => r.pointId === pt.id)
      .sort((a, b) => a.date.localeCompare(b.date))
    const target = rs[Math.min(rs.length - 1, 2)] // 第 3 期异常增厚
    if (target) target.thicknessMm = +(target.thicknessMm + 0.9 + (k % 3) * 0.25).toFixed(2)
  }

  // 可疑增厚：统一按点计算并落标
  const byPoint = new Map<string, Reading[]>()
  for (const r of readings) {
    if (!byPoint.has(r.pointId)) byPoint.set(r.pointId, [])
    byPoint.get(r.pointId)!.push(r)
  }
  let suspiciousTotal = 0
  for (const [pid, rs] of byPoint) {
    const sus = computeSuspicious(rs)
    for (const r of rs) if (sus.has(r.id)) {
      r.suspicious = true
      suspiciousTotal++
    }
  }

  // ---- 坏行（掺在 2026 导入里）----
  const samplePoint = points[100]
  const knownCode = samplePoint?.code ?? 'CDU-OH-2001-T0101'
  const badDefs: { cat: BadRow['category']; reason: string; raw: string }[] = [
    { cat: 'unknown_point', reason: '点号在台账中找不到（可能纸质图编号录入错误）', raw: 'CDU-OH-2001-T9999,2026-09-08,7.4,mm' },
    { cat: 'unknown_point', reason: '点号在台账中找不到', raw: 'OH-2001-T102A,2026-09-08,8.1,mm' },
    { cat: 'too_thick', reason: '读数 12.60mm 大于该管名义壁厚 9.53mm，请核对探头/母材', raw: `${knownCode},2026-09-08,12.60,mm` },
    { cat: 'too_thick', reason: '读数大于名义壁厚（疑似读到法兰/堆焊层）', raw: 'CDU-OH-2002-T0007,2026-09-08,11.80,mm' },
    { cat: 'inch_unit', reason: '单位为英寸(in)，未换算成 mm（0.322in≈8.18mm），已隔离', raw: 'CDU-OH-2001-T0110,2026-09-08,0.322,inch' },
    { cat: 'inch_unit', reason: '数值像英寸且单位列填 in，请 ×25.4 后重导', raw: 'CDU-AC-4101-T0203,2026-09-08,0.271,in' },
    { cat: 'parse', reason: '厚度列不是数字', raw: 'CDU-OH-2003-T0044,2026/9/8,磨损,mm' },
    { cat: 'parse', reason: '列数不足/日期无法解析', raw: 'CDU-OH-2003-T0045,7.2' },
    { cat: 'unknown_point', reason: '点号在台账中找不到（空格/全角字符）', raw: ' CDU-OH-2001-T0101 ,2026-09-08,7.0,mm' },
    { cat: 'too_thick', reason: '读数 10.4mm 大于 Sch40 名义壁厚 8.18mm', raw: 'CDU-RF-4201-T0033,2026-09-08,10.4,mm' },
    { cat: 'inch_unit', reason: '单位列写成“英寸”，已隔离待换算', raw: 'INJ-W-5002-T0012,2026-09-08,0.188,英寸' },
    { cat: 'parse', reason: '空行/无效行', raw: ',,,,', }
  ]
  badDefs.forEach((b, i) =>
    badrows.push({
      id: `bad-${i + 1}`,
      fileName: '2026秋季测厚导入_含坏行.csv',
      rowNumber: i + 2,
      raw: b.raw,
      reason: b.reason,
      category: b.cat,
      createdAt: '2026-09-10T09:00:00.000Z'
    })
  )

  const resolved = pipelines.map((p) => resolveLine(p, fittings.filter((f) => f.pipelineId === p.id)))

  return { pipelines, fittings, points, readings, periods: PERIODS, cscans, badrows, resolved }
}
