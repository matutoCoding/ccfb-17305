/**
 * 核心正确性测试：
 *  1) 任意弯头按 钟点+轴向距离 定位，必须落在圆环曲面上，误差 << 管径 2%
 *  2) 外弧/内弧解析位置必须精确（R±r）
 *  3) 表面距离插值：外弧减薄不得串到内弧，不得穿心
 *  4) API570 速率/寿命基本口径
 * 运行：npm run test:core
 */
import type { Fitting, Pipeline, Reading, Vec3 } from '../src/domain/types'
import { resolveLine, locatePoint, surfaceDistance } from '../src/domain/geometry'
import { clockRadial, radialToClock, norm, sub, dot, cross, rotateAround, scale, len } from '../src/domain/vec'
import { evaluateField, assessPoint, thicknessBasis, computeSuspicious } from '../src/domain/analysis'
import { generateSeed } from '../src/data/seed'
import { buildPipelineLifeRows } from '../src/domain/life-table'
import { NOW } from '../src/domain/now'

let pass = 0
let fail = 0
function ok(cond: boolean, msg: string) {
  if (cond) {
    pass++
    console.log(`  ✓ ${msg}`)
  } else {
    fail++
    console.error(`  ✗ ${msg}`)
  }
}
function approx(a: number, b: number, eps: number) {
  return Math.abs(a - b) <= eps
}

function makePipeline(partial: Partial<Pipeline> = {}): Pipeline {
  return {
    id: 'P1',
    code: 'CDU-OH-1001',
    unit: '常减压',
    block: '常压塔顶',
    medium: '塔顶油气',
    opTempC: 120,
    opPressureMPa: 0.25,
    designPressureMPa: 0.6,
    material: '20#',
    allowableStressMPa: 137,
    weldEfficiency: 1,
    corrosionAllowanceMm: 3,
    dn: 200,
    schedule: 'Sch40',
    outerDiameterMm: 219.1,
    nominalWallMm: 8.18,
    inspectionCycleYears: 3,
    ...partial
  }
}

function fit(partial: Partial<Fitting> & Pick<Fitting, 'seq' | 'code' | 'kind' | 'dir'>): Fitting {
  return {
    id: `F${partial.seq}`,
    pipelineId: 'P1',
    lengthMm: 1000,
    ...partial
  } as Fitting
}

console.log('\n[1] 弯头定位精度（独立圆环曲面校核，阈值 2% OD）')
{
  const p = makePipeline()
  // +X 直管 -> 90° LR 弯头向上(+Y) -> +Y
  const fittings: Fitting[] = [
    fit({ seq: 1, code: 'P-1', kind: 'pipe', dir: [1, 0, 0], lengthMm: 2000 }),
    fit({ seq: 2, code: 'E-1', kind: 'elbow_lr', dir: [0, 1, 0] }),
    fit({ seq: 3, code: 'P-2', kind: 'pipe', dir: [0, 1, 0], lengthMm: 1500 })
  ]
  const line = resolveLine(p, fittings)
  ok(line.errors.length === 0, `标准 +X→+Y 走向无错误（实际 errors=${JSON.stringify(line.errors)}）`)
  const rf = line.items[1]
  const OD = p.outerDiameterMm
  const r = OD / 2
  const R = rf.bendRadius!
  const C = rf.bendCenter!
  const axis = rf.bendAxis!

  let maxTorusErr = 0
  let maxLocErr = 0
  // 穷举 轴向 × 钟点
  for (let i = 0; i <= 40; i++) {
    const s = (rf.length * i) / 40
    for (let c = 0; c < 48; c++) {
      const clock = (c / 48) * 12
      const L = rf.locate(s, clock)
      // 独立圆环方程：(rho - R)^2 + alongAxis^2 ≈ r^2
      const w = sub(L.position, C)
      const along = dot(w, axis)
      const rho = Math.sqrt(Math.max(0, w[0] ** 2 + w[1] ** 2 + w[2] ** 2 - along ** 2))
      const torusErr = Math.abs(Math.hypot(rho - R, along) - r)
      maxTorusErr = Math.max(maxTorusErr, torusErr)
      // 定位点到 locate 自报位置一致（这里直接就是它），再校验法向指向外
      const nDot = dot(L.normal, norm(sub(L.position, rf.centerAt(s).p)))
      okOnceNormal(nDot)
    }
  }
  function okOnceNormal(d: number) {
    if (d < 0.9999) maxLocErr = Math.max(maxLocErr, 1 - d)
  }
  ok(maxTorusErr < 1e-3, `所有 41×48 个定位点落在圆环曲面，最大偏差 ${maxTorusErr.toExponential(2)} mm`)
  ok(maxTorusErr < 0.02 * OD, `最大偏差 ${maxTorusErr.toFixed(4)}mm < 2%OD=${(0.02 * OD).toFixed(2)}mm`)
  ok(maxLocErr < 1e-3, `法向严格沿截面径向`)

  // 外弧/内弧解析位置
  for (let i = 0; i <= 10; i++) {
    const phi = (rf.bendAngleRad! * i) / 10
    const s = R * phi
    const q = rotateAround(scale(rf.bendM!, -1), axis, phi) // 圆心->中心线
    const t = rotateAround(rf.inTangent, axis, phi)
    const outerClock = radialToClock(t, q) // q 即背离圆心=外弧
    const innerClock = radialToClock(t, scale(q, -1))
    const lo = rf.locate(s, outerClock)
    const li = rf.locate(s, innerClock)
    const expectedOuter = add2(C, scale(q, R + r))
    const expectedInner = add2(C, scale(q, R - r))
    const eo = len(sub(lo.position, expectedOuter))
    const ei = len(sub(li.position, expectedInner))
    maxLocErr = Math.max(maxLocErr, eo, ei)
    if (i === 5) {
      ok(eo < 1e-3 && ei < 1e-3, `45°截面外弧/内弧与解析 R±r 位置偏差 outer=${eo.toExponential(1)} inner=${ei.toExponential(1)}mm`)
      ok(lo.outerDot > 0.9999 && li.outerDot < -0.9999, `outerDot 外≈+1 内≈-1（${lo.outerDot.toFixed(4)}, ${li.outerDot.toFixed(4)}）`)
    }
  }
  ok(maxLocErr < 0.02 * OD, `外/内弧最大位置偏差 ${maxLocErr.toExponential(2)}mm 远小于 2%OD`)

  // 钟点基准：入口水平 +X 管，12点必须是世界 +Y
  const pipe = line.items[0]
  const top = pipe.locate(1000, 0)
  ok(approx(top.position[1], r, 1e-6) && approx(top.position[0], 1000, 1e-6), '水平管 12 点 = 正上方')
  const three = pipe.locate(1000, 3)
  // t=+X, top=+Y, right=cross(X,Y)=+Z
  ok(approx(three.position[2], r, 1e-6), '顺流向看 3 点 = 右侧(+Z)')
}

console.log('\n[2] 多种弯头朝向 / 45度 / 水平转弯 定位')
{
  const p = makePipeline({ dn: 300, outerDiameterMm: 323.9 })
  const routes: { name: string; dirs: Vec3[]; kinds: Fitting['kind'][] }[] = [
    { name: '水平东->北转弯', dirs: [[1, 0, 0], [0, 0, 1]], kinds: ['pipe', 'elbow_lr'] },
    { name: '东->下转弯', dirs: [[1, 0, 0], [0, -1, 0]], kinds: ['pipe', 'elbow_lr'] },
    { name: '45度上扬', dirs: [[1, 0, 0], [Math.SQRT1_2, Math.SQRT1_2, 0]], kinds: ['pipe', 'elbow45'] },
    { name: 'SR弯头', dirs: [[0, 0, 1], [1, 0, 0]], kinds: ['pipe', 'elbow_sr'] }
  ]
  for (const rt of routes) {
    const fs: Fitting[] = rt.dirs.map((d, i) =>
      fit({ seq: i + 1, code: `F${i}`, kind: rt.kinds[i], dir: d, lengthMm: i === 0 ? 1200 : 0 })
    )
    const line = resolveLine(p, fs)
    const rf = line.items[1]
    const OD = p.outerDiameterMm
    const C = rf.bendCenter!
    const axis = rf.bendAxis!
    let maxErr = 0
    for (let i = 0; i <= 20; i++) {
      const s = (rf.length * i) / 20
      for (let c = 0; c < 24; c++) {
        const L = rf.locate(s, c / 2)
        const w = sub(L.position, C)
        const along = dot(w, axis)
        const rho = Math.sqrt(Math.max(0, dot(w, w) - along * along))
        const err = Math.abs(Math.hypot(rho - rf.bendRadius!, along) - OD / 2)
        maxErr = Math.max(maxErr, err)
      }
    }
    ok(maxErr < 0.02 * OD, `${rt.name}: 最大曲面偏差 ${maxErr.toExponential(2)}mm < 2%OD`)
  }
}

console.log('\n[3] 走向接不上 / 总长对不上 必须报错')
{
  const p = makePipeline({ drawingTotalLengthM: 999 })
  const bad: Fitting[] = [
    fit({ seq: 1, code: 'P1', kind: 'pipe', dir: [1, 0, 0], lengthMm: 1000 }),
    // 90 弯头却给 30 度方向
    fit({ seq: 2, code: 'E-bad', kind: 'elbow_lr', dir: [Math.cos((30 * Math.PI) / 180), Math.sin((30 * Math.PI) / 180), 0] })
  ]
  const line = resolveLine(p, bad)
  ok(line.errors.some((e) => e.includes('走向接不上')), '弯头夹角不符报“走向接不上”')
  ok(line.errors.some((e) => e.includes('总长对不上图纸')), '总长与图纸偏差>2% 报错')
}

console.log('\n[4] 表面距离：外弧到内弧绕半圈，不穿心')
{
  const r = 100
  const outer = { s: 500, psi: 0, radius: r }
  const inner = { s: 500, psi: Math.PI, radius: r }
  const dSurf = surfaceDistance(outer, inner)
  ok(approx(dSurf, Math.PI * r, 1e-6), `外-内表面距离=πr=${(Math.PI * r).toFixed(1)}（实际 ${dSurf.toFixed(1)}）`)
  ok(dSurf > 2 * r, `表面距离 ${dSurf.toFixed(0)} > 穿心直线 2r=${2 * r}`)
  const nearOuter = { s: 500, psi: 0.05, radius: r }
  ok(surfaceDistance(outer, nearOuter) < 6, '外弧邻近点距离很小')
}

console.log('\n[5] IDW 插值：外弧减薄不串到内弧')
{
  // 构造一个虚拟弯头 fittingId=E，r=100
  const fid = 'E'
  const r = 100
  const samples = []
  // 外弧 psi=0 一片严重减薄 3.0mm（密网格）
  for (let s = 300; s <= 700; s += 50)
    for (let psi = -0.25; psi <= 0.25; psi += 0.05) {
      let a = psi
      if (a < 0) a += Math.PI * 2
      samples.push({ fittingId: fid, s, psi: a, radius: r, value: 3.0 })
    }
  // 内弧 psi=π 厚 9.0mm（密网格）
  for (let s = 300; s <= 700; s += 50)
    for (let psi = Math.PI - 0.25; psi <= Math.PI + 0.25; psi += 0.05)
      samples.push({ fittingId: fid, s, psi, radius: r, value: 9.0 })

  const outerVal = evaluateField(samples, fid, 500, 0, r, 4)!
  const innerVal = evaluateField(samples, fid, 500, Math.PI, r, 4)!
  console.log(`    外弧中心插值=${outerVal.toFixed(3)}  内弧中心插值=${innerVal.toFixed(3)}`)
  ok(outerVal < 3.2, `外弧插值保持薄值 ≈3.0（${outerVal.toFixed(2)}）`)
  ok(innerVal > 8.5, `内弧插值保持厚值 ≈9.0，外弧薄点未串入（${innerVal.toFixed(2)}）`)

  // 受控对照：测点在内弧目标截面处缺失，最近内弧厚点在轴向 2.6r 外，
  // 而外弧薄点就在管心正对面。表面距离 πr 与穿心距离 2r 的差异（p=4 权重差约 6 倍）
  // 会导致：表面度量仍由同侧厚点主导，而穿心欧氏被对面薄点主导。
  const controlled = [
    { fittingId: fid, s: 500, psi: 0, radius: r, value: 3.0 }, // 外弧薄，正对管心
    { fittingId: fid, s: 760, psi: Math.PI, radius: r, value: 9.0 } // 内弧厚，轴向 2.6r
  ]
  const surfV = evaluateField(controlled, fid, 500, Math.PI, r, 4)!
  function euclidIDWControlled(targetS: number, targetPsi: number) {
    const tx = r * Math.cos(targetPsi)
    const ty = r * Math.sin(targetPsi)
    let ws = 0,
      vs = 0
    for (const q of controlled) {
      const x = r * Math.cos(q.psi)
      const y = r * Math.sin(q.psi)
      const d = Math.hypot(targetS - q.s, tx - x, ty - y)
      const w = 1 / Math.pow(d / r, 4)
      ws += w
      vs += w * q.value
    }
    return vs / ws
  }
  const euclV = euclidIDWControlled(500, Math.PI)
  console.log(`    受控对照：表面度量=${surfV.toFixed(2)}（厚点主导）  穿心欧氏=${euclV.toFixed(2)}（被对面薄点拉低）`)
  ok(surfV > 6.0, `表面距离下内弧目标仍由同侧厚点主导（${surfV.toFixed(2)}）`)
  ok(euclV < surfV - 1.0, `穿心欧氏明显把外弧薄值带到内弧（${euclV.toFixed(2)} < ${surfV.toFixed(2)}），证明必须用表面度量`)

  // 跨管件隔离
  samples.push({ fittingId: 'OTHER', s: 500, psi: Math.PI, radius: r, value: 1.0 })
  const v = evaluateField(samples, fid, 500, Math.PI, r, 4)!
  ok(v > 8.5, '其他管件（焊口/法兰另一侧）样本不参与本件插值')
}

console.log('\n[6] 可疑增厚标记 + API570 寿命口径')
{
  const p = makePipeline()
  const basis = thicknessBasis(p)
  console.log(
    `    tPressure=${basis.tPressure.toFixed(2)} tMin=${basis.tMin.toFixed(2)} tWithCA=${basis.tWithCA.toFixed(2)} nominal=${basis.nominal}`
  )
  ok(basis.tMin > 0 && basis.tMin < basis.nominal, '最小要求壁厚为正且小于名义壁厚')

  const pid = 'PT1'
  const mk = (date: string, t: number): any => ({ id: `R${date}`, pointId: pid, pipelineId: 'P1', periodId: 'X', date, thicknessMm: t })
  const readings = [
    mk('2023-05-01', 8.0),
    mk('2024-05-01', 7.4),
    mk('2025-05-01', 8.3), // 可疑增厚 +0.9
    mk('2026-05-01', 6.8)
  ]
  const sus = computeSuspicious(readings)
  ok(sus.has(readings[2].id), '增厚 0.9mm 超 0.5 误差 -> 可疑')
  const a = assessPoint(p, pid, readings, new Date('2026-11-27'))
  ok(a.suspiciousCount >= 1, '评估结果计入可疑数')
  ok(a.longRate != null && a.longRate > 0, `长期速率=${a.longRate?.toFixed(3)} mm/y`)
  ok(a.remainingLifeYears != null && isFinite(a.remainingLifeYears), `剩余寿命=${a.remainingLifeYears?.toFixed(2)} 年`)
  ok(!!a.nextDate, `下次检测日期=${a.nextDate}`)

  // 减薄速率已知例：10mm -> 7mm 整 3 年 = 1.0 mm/y
  const pid2 = 'PT2'
  const r2 = [
    { id: 'a', pointId: pid2, pipelineId: 'P1', periodId: 'X', date: '2023-01-01', thicknessMm: 10 },
    { id: 'b', pointId: pid2, pipelineId: 'P1', periodId: 'X', date: '2026-01-01', thicknessMm: 7 }
  ] as Reading[]
  const a2 = assessPoint(p, pid2, r2, new Date('2026-01-01'))
  ok(approx(a2.longRate!, 1.0, 0.01), `三年减 3mm -> 1.0mm/y（实际 ${a2.longRate?.toFixed(3)}）`)
  const expectRL = (7 - basis.tMin) / 1.0
  ok(approx(a2.remainingLifeYears!, expectRL, 0.05), `剩余寿命=(7-tMin)/速率=${expectRL.toFixed(2)} 年`)
}

function add2(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

console.log('\n[7] 三维弹窗 / 寿命表 / 导出 数字一致性（同一 NOW + 同一 assessPoint）')
{
  const seed = generateSeed()
  const rows = buildPipelineLifeRows(seed.resolved, seed.points, seed.readings)
  let checked = 0
  let allMatch = true
  for (const row of rows) {
    const wid = row.worst?.worstPointId
    if (!wid) continue
    // 三维里点该点时 PointHistory 拿到的结果
    const in3d = assessPoint(seed.pipelines.find((p) => p.id === row.pipelineId)!, wid, seed.readings, NOW)
    const rlTable = row.worst!.remainingLifeYears
    const rl3d = in3d.remainingLifeYears
    const sameRl =
      rlTable === rl3d ||
      (!isFinite(rlTable) && rl3d != null && !isFinite(rl3d)) ||
      (isFinite(rlTable) && isFinite(rl3d!) && approx(rlTable, rl3d!, 1e-9))
    const sameThk = approx(row.worst!.latestMinMm, in3d.latestThickness ?? NaN, 1e-9)
    if (!sameRl || !sameThk) {
      allMatch = false
      console.error('    MISMATCH', row.code, wid, rlTable, rl3d, row.worst!.latestMinMm, in3d.latestThickness)
    }
    checked++
  }
  ok(checked >= 20, `覆盖 ${checked} 条管线最不利点`)
  ok(allMatch, '每条管线：寿命表/导出所用 RL、最薄厚度 与 三维点该点 assessPoint 完全一致')

  // 旗舰故事线的端到端口径
  const flagship = rows.find((r) => r.code === 'CDU-OH-2001')!
  ok(flagship.status === 'below_tmin', `旗舰线最不利状态=低于最小壁厚（实际 ${flagship.status}）`)
  ok((flagship.worst?.latestMinMm ?? 99) < flagship.tMin, '旗舰最薄外弧点 < tMin')
  const inner2025 = seed.readings
    .filter((r) => r.periodId === 'per-2025')
    .filter((r) => seed.points.find((p) => p.id === r.pointId)?.zone === 'elbow_inner' && r.pipelineId === flagship.pipelineId)
  const innerMin = Math.min(...inner2025.map((r) => r.thicknessMm))
  ok(innerMin > flagship.tMin + 2.5, `2025 内弧测点仍明显合格（最小 ${innerMin.toFixed(2)} vs tMin ${flagship.tMin.toFixed(2)}），外弧却已穿底`)
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
if (fail > 0) process.exit(1)
