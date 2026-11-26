import type { BadRow, Pipeline, ThicknessPoint } from '../domain/types'

export interface ParsedCsvRow {
  rowNumber: number
  cells: string[]
  code: string
  date: string
  rawThickness: string
  unit: string
  thickness?: number
}

/** 支持引号的 CSV 拆行/拆列 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQ = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else inQ = false
      } else cell += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell.length || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

export interface ImportOutcome {
  valid: { point: ThicknessPoint; thicknessMm: number; date: string }[]
  bad: Omit<BadRow, 'id' | 'createdAt'>[]
  total: number
}

function normCode(s: string) {
  return s.trim().replace(/\s+/g, '').toUpperCase()
}

function isInchUnit(u: string) {
  return /^(in|inch|inches|英寸|吋)$/i.test(u.trim())
}

/**
 * 校验一期测厚 CSV。
 * 表头可识别：点号/编号/point；日期/date；厚度/壁厚/thickness/reading；单位/unit。
 * 无表头时按 点号,日期,厚度,单位 位置解析。
 */
export function validateThicknessCsv(
  fileName: string,
  text: string,
  points: ThicknessPoint[],
  pipelines: Pipeline[],
  fallbackDate?: string
): ImportOutcome {
  const grid = parseCsv(text)
  const byCode = new Map<string, ThicknessPoint>()
  for (const p of points) byCode.set(normCode(p.code), p)
  const plById = new Map(pipelines.map((p) => [p.id, p]))

  let headerIdx = -1
  let colCode = 0,
    colDate = 1,
    colThk = 2,
    colUnit = 3
  if (grid.length) {
    const h = grid[0].map((c) => c.trim().toLowerCase())
    const find = (...keys: string[]) => h.findIndex((c) => keys.some((k) => c.includes(k)))
    const cCode = find('点号', '编号', 'point', 'tag')
    const cDate = find('日期', 'date', '时间')
    const cThk = find('厚度', '壁厚', 'thick', 'reading', '读数')
    const cUnit = find('单位', 'unit')
    if (cCode >= 0 && cThk >= 0) {
      headerIdx = 0
      colCode = cCode
      colDate = cDate >= 0 ? cDate : 1
      colThk = cThk
      colUnit = cUnit >= 0 ? cUnit : 3
    }
  }

  const valid: ImportOutcome['valid'] = []
  const bad: ImportOutcome['bad'] = []
  let total = 0

  for (let ri = headerIdx + 1; ri < grid.length; ri++) {
    const cells = grid[ri]
    const rowNumber = ri + 1
    const rawLine = cells.join(',')
    if (!cells.some((c) => c.trim() !== '')) continue
    total++
    const codeRaw = cells[colCode] ?? ''
    const dateRaw = (cells[colDate] ?? '').trim()
    const thkRaw = (cells[colThk] ?? '').trim()
    const unitRaw = (cells[colUnit] ?? '').trim()
    const code = normCode(codeRaw)

    const point = byCode.get(code)
    if (!point) {
      bad.push({
        fileName,
        rowNumber,
        raw: rawLine,
        category: 'unknown_point',
        reason: `点号“${codeRaw.trim()}”在台账中找不到`
      })
      continue
    }

    if (isInchUnit(unitRaw)) {
      const inch = parseFloat(thkRaw)
      const conv = isFinite(inch) ? `（${inch} in ≈ ${(inch * 25.4).toFixed(2)} mm）` : ''
      bad.push({
        fileName,
        rowNumber,
        raw: rawLine,
        category: 'inch_unit',
        reason: `单位为英寸，请 ×25.4 换算成 mm 后重导${conv}`
      })
      continue
    }

    // 单位列空但数值明显是英寸（0.05~1.5 之间且两位以上小数）只提示，不强制
    const value = Number(thkRaw)
    if (!thkRaw || !isFinite(value) || value <= 0) {
      bad.push({
        fileName,
        rowNumber,
        raw: rawLine,
        category: 'parse',
        reason: `厚度值“${thkRaw}”不是有效正数`
      })
      continue
    }

    const pl = plById.get(point.pipelineId)
    const nominal = pl?.nominalWallMm ?? Infinity
    if (value > nominal + 1e-6) {
      bad.push({
        fileName,
        rowNumber,
        raw: rawLine,
        category: 'too_thick',
        reason: `读数 ${value.toFixed(2)}mm 大于 ${pl?.code ?? ''} 名义壁厚 ${nominal.toFixed(2)}mm`
      })
      continue
    }

    const date = normalizeDate(dateRaw) || fallbackDate || new Date().toISOString().slice(0, 10)
    valid.push({ point, thicknessMm: Math.round(value * 100) / 100, date })
  }

  return { valid, bad, total }
}

export function normalizeDate(s: string): string | null {
  const t = s.trim()
  if (!t) return null
  // 2026/9/8 -> 2026-09-08
  const m = t.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  const d = new Date(t)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/** 生成一份带坏行的示例 CSV 文本 */
export function sampleCsv(points: ThicknessPoint[]): string {
  const head = '点号,日期,厚度,单位,测量人'
  const good = points.slice(0, 6)
  const lines = good.map((p, i) => `${p.code},2026-09-08,${(p as any)._demo ?? (6 + i * 0.3).toFixed(2)},mm,张工`)
  return [
    head,
    ...lines,
    'CDU-OH-2001-T9999,2026-09-08,7.40,mm,张工',
    `${good[0]?.code ?? 'CDU-OH-2001-T0001'},2026-09-08,99.9,mm,张工`,
    'CDU-OH-2001-T0110,2026-09-08,0.322,inch,李工',
    'CDU-OH-2003-T0044,2026/9/8,磨损,mm,李工'
  ].join('\n')
}
