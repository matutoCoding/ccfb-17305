import { generateSeed } from '../src/data/seed'

const t0 = Date.now()
const s = generateSeed()
console.log('pipelines', s.pipelines.length)
console.log('fittings', s.fittings.length)
console.log('points', s.points.length)
console.log('readings', s.readings.length)
console.log('cscans', s.cscans.length, 'cells', s.cscans.reduce((a, c) => a + c.values.length, 0))
console.log('badrows', s.badrows.length)
console.log('resolved lines', s.resolved.length)
const errCount = s.resolved.reduce((a, l) => a + l.errors.length, 0)
console.log('geometry errors across seed:', errCount)
const warnCount = s.resolved.reduce((a, l) => a + l.warnings.length, 0)
console.log('geometry warnings:', warnCount)
if (errCount) {
  for (const l of s.resolved) for (const e of l.errors.slice(0, 5)) console.log('  ERR', l.pipeline.code, e)
}
// 检查热点首线最不利管件
const line0 = s.resolved[0]
console.log('line0 items', line0.items.length, 'total m', (line0.totalLengthMm / 1000).toFixed(1))
console.log('elapsed ms', Date.now() - t0)
// 校验所有点都能定位且在范围内
let oor = 0
for (const pt of s.points) {
  const rl = s.resolved.find((r) => r.pipeline.id === pt.pipelineId)!
  const rf = rl.items.find((i) => i.fitting.id === pt.fittingId)
  if (!rf) {
    console.log('MISSING FITTING', pt.code)
    continue
  }
  let ss = pt.axialDistanceMm
  if (pt.reference === 'downstream_weld' || pt.reference === 'fitting_end') ss = rf.length - ss
  if (ss < -1 || ss > rf.length + 1) {
    oor++
    if (oor < 10) console.log('OUT OF RANGE', pt.code, ss.toFixed(0), '/', rf.length.toFixed(0), pt.reference, pt.axialDistanceMm)
  }
}
console.log('points out of axial range:', oor)

// 旗舰热点评估
import { assessFitting, thicknessBasis } from '../src/domain/analysis'
const l0 = s.resolved[0]
const b = thicknessBasis(l0.pipeline)
console.log('\n旗舰线 tMin', b.tMin.toFixed(2), 'nominal', b.nominal)
// 找到热点弯头（含 -O 点）
const outerPt = s.points.find(p => p.pipelineId === l0.pipeline.id && p.code.endsWith('-O'))
console.log('outer point', outerPt?.code, outerPt?.clock)
if (outerPt) {
  const rs = s.readings.filter(r => r.pointId === outerPt.id).sort((a,c)=>a.date.localeCompare(c.date))
  console.log('outer readings', rs.map(r=>r.thicknessMm).join(', '))
}
const innerPts = s.points.filter(p => p.pipelineId === l0.pipeline.id && p.zone==='elbow_inner')
const latestInner = innerPts.flatMap(p=>s.readings.filter(r=>r.pointId===p.id)).filter(r=>r.periodId==='per-2025')
console.log('2025 inner readings min/avg', Math.min(...latestInner.map(r=>r.thicknessMm)).toFixed(2), (latestInner.reduce((a,r)=>a+r.thicknessMm,0)/latestInner.length).toFixed(2), 'n=', latestInner.length)
// 评估热点弯头
if (outerPt) {
  const fa = assessFitting(l0, outerPt.fittingId, s.points, s.readings, new Date('2026-11-27'))
  console.log('hot fitting assess ratio', fa.ratio.toFixed(2), 'latestMin', fa.latestMinMm.toFixed(2), 'RL', fa.remainingLifeYears.toFixed(2), 'status', fa.status, 'worst', fa.worstPointCode)
}
