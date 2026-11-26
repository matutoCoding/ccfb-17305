import type { Reading, ThicknessPoint } from './types'
import type { ResolvedLine } from './geometry'
import { assessFitting, thicknessBasis, type FittingAssessment } from './analysis'
import { NOW } from './now'

export interface PipelineLifeRow {
  pipelineId: string
  code: string
  block: string
  medium: string
  dn: number
  material: string
  tMin: number
  nominal: number
  cycle: number
  fittingCount: number
  pointCount: number
  worst?: FittingAssessment
  /** 全管线最不利剩余寿命（年） */
  remainingLifeYears: number
  governingRate: number
  nextDate?: string
  status: FittingAssessment['status']
}

/** 每条管线取最不利管件；寿命页表格与 CSV 导出共用，保证数字一致 */
export function buildPipelineLifeRows(
  lines: ResolvedLine[],
  points: ThicknessPoint[],
  readings: Reading[]
): PipelineLifeRow[] {
  return lines.map((line) => {
    const p = line.pipeline
    const basis = thicknessBasis(p)
    const linePts = points.filter((x) => x.pipelineId === p.id)
    let worst: FittingAssessment | undefined
    for (const rf of line.items) {
      const has = linePts.some((x) => x.fittingId === rf.fitting.id && !x.isCscan)
      if (!has) continue
      const fa = assessFitting(line, rf.fitting.id, points, readings, NOW)
      if (!worst) worst = fa
      else {
        const a = worst.remainingLifeYears
        const b = fa.remainingLifeYears
        // below_tmin / 较小 RL 优先
        if (fa.status === 'below_tmin' && worst.status !== 'below_tmin') worst = fa
        else if (b < a) worst = fa
      }
    }
    const rl = worst?.remainingLifeYears ?? Infinity
    return {
      pipelineId: p.id,
      code: p.code,
      block: p.block,
      medium: p.medium,
      dn: p.dn,
      material: p.material,
      tMin: basis.tMin,
      nominal: basis.nominal,
      cycle: p.inspectionCycleYears,
      fittingCount: line.items.length,
      pointCount: linePts.filter((x) => !x.isCscan).length,
      worst,
      remainingLifeYears: rl,
      governingRate: worst?.governingRate ?? 0,
      nextDate: worst?.nextDate,
      status: worst?.status ?? 'no_data'
    }
  })
}

export function downloadTextFile(filename: string, text: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob(['﻿' + text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export function toCsv(rows: (string | number | undefined | null)[][]): string {
  return rows
    .map((r) =>
      r
        .map((c) => {
          const s = c == null ? '' : String(c)
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
        })
        .join(',')
    )
    .join('\n')
}
