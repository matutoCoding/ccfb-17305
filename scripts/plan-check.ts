import { generateSeed } from '../src/data/seed'
import { buildPlan } from '../src/domain/plan'
import { NOW } from '../src/domain/now'

const s = generateSeed()
const t0 = Date.now()
const plan = buildPlan(s.resolved, s.points, s.readings, NOW)
console.log('plan ms', Date.now() - t0, 'total', plan.length)
const byReason: Record<string, number> = {}
const byPrio: Record<string, number> = { high: 0, medium: 0, low: 0 }
for (const p of plan) {
  byReason[p.reason] = (byReason[p.reason] ?? 0) + 1
  byPrio[p.priority]++
}
console.log('prio', byPrio)
console.log('reasons', byReason)
// 每条管线数量分布
const perLine: Record<string, number> = {}
for (const p of plan) perLine[p.pipelineCode] = (perLine[p.pipelineCode] ?? 0) + 1
const vals = Object.entries(perLine).sort((a, b) => b[1] - a[1])
console.log('top lines', vals.slice(0, 6))
console.log('lines with suggestions', vals.length)
