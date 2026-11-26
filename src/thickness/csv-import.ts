/**
 * 测厚 CSV / 弯头 C 扫描网格导入。
 * 坏行不进正式读数库，按原因单列：
 *  - POINT_NOT_FOUND          点号在测点档案中找不到
 *  - THICKNESS_EXCEEDS_NOMINAL 读数 > 名义壁厚
 *  - BAD_UNIT_INCH            数值小到像英寸（< 名义壁厚 15%），25.4 换算后反而超限
 *  - PARSE_ERROR              行列损坏
 */
import { BadRow, ThicknessPoint, ThicknessReading } from '../types';
import { INCH_RATIO_THRESHOLD } from '../standards';

export interface ParsedCsv {
  readings: Omit<ThicknessReading, 'id' | 'roundId'>[];
  badRows: Omit<BadRow, 'id' | 'roundId'>[];
}

/** 支持表头：点号,厚度(mm) 或 pointNo,thickness；逗号/制表符分隔，自动去 BOM */
export function parseThicknessCsv(
  text: string,
  points: ThicknessPoint[],
  nominalWallByPoint: Map<string, number>,
): ParsedCsv {
  const clean = text.replace(/^﻿/, '').trim();
  const lines = clean.split(/\r?\n/);
  const sep = lines[0]?.includes('\t') ? '\t' : ',';
  const header = splitCsvLine(lines[0] ?? '', sep).map((h) => h.trim());
  const noIdx = findHeader(header, ['点号', '点位编号', 'pointno', 'point_no', 'tag']);
  const tIdx = findHeader(header, ['厚度', '厚度(mm)', 'thickness', 't', 'wall']);
  if (noIdx < 0 || tIdx < 0) {
    return {
      readings: [],
      badRows: [{
        source: 'CSV', rowIndex: 0, raw: lines[0] ?? '',
        reason: 'PARSE_ERROR', detail: '表头需包含 点号 与 厚度 两列',
      }],
    };
  }
  const pointByNo = new Map(points.map((p) => [p.pointNo.toLowerCase(), p]));
  const readings: ParsedCsv['readings'] = [];
  const badRows: ParsedCsv['badRows'] = [];

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const cols = splitCsvLine(raw, sep);
    const pointNo = (cols[noIdx] ?? '').trim();
    const tRaw = (cols[tIdx] ?? '').trim();
    if (!pointNo) {
      badRows.push({ source: 'CSV', rowIndex: i, raw, reason: 'PARSE_ERROR', detail: '点号列为空' });
      continue;
    }
    const t = Number(tRaw);
    if (!Number.isFinite(t)) {
      badRows.push({ source: 'CSV', rowIndex: i, raw, reason: 'PARSE_ERROR', detail: `厚度无法解析: "${tRaw}"` });
      continue;
    }
    const point = pointByNo.get(pointNo.toLowerCase());
    if (!point) {
      badRows.push({ source: 'CSV', rowIndex: i, raw, reason: 'POINT_NOT_FOUND', detail: `点号 ${pointNo} 在测点档案中不存在` });
      continue;
    }
    const nominal = nominalWallByPoint.get(point.id);
    if (nominal != null) {
      if (t < nominal * INCH_RATIO_THRESHOLD) {
        badRows.push({
          source: 'CSV', rowIndex: i, raw, reason: 'BAD_UNIT_INCH',
          detail: `读数 ${t} 仅为名义壁厚 ${nominal}mm 的 ${(t / nominal * 100).toFixed(1)}%，疑似单位填成英寸（换算 ${(t * 25.4).toFixed(2)}mm 仍超限）`,
        });
        continue;
      }
      if (t > nominal) {
        badRows.push({
          source: 'CSV', rowIndex: i, raw, reason: 'THICKNESS_EXCEEDS_NOMINAL',
          detail: `读数 ${t}mm 大于名义壁厚 ${nominal}mm`,
        });
        continue;
      }
    }
    readings.push({ pointNo: point.pointNo, pipelineId: point.pipelineId, thickness: round3(t) });
  }
  return { readings, badRows };
}

export interface ParsedCScan {
  grid: {
    pointNoBase: string;
    axialStart: number;
    axialStep: number;
    clockStart: number;
    clockStep: number;
    rows: number;
    cols: number;
    values: number[];
  };
  badCells: { row: number; col: number; raw: string; detail: string }[];
}

/**
 * C 扫描网格 CSV：
 * 元信息行 #axialStart=,#axialStep=,#clockStart=,#clockStep=,#pointNoBase=
 * 其后首行/首列为网格坐标，单元格为厚度 mm，空/非数记坏格。
 */
export function parseCScanCsv(text: string): ParsedCScan {
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const meta = new Map<string, number | string>();
  let dataStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#\s*(\w+)\s*=\s*(.+)$/);
    if (!m) { dataStart = i; break; }
    const num = Number(m[2]);
    meta.set(m[1], Number.isFinite(num) ? num : m[2].trim());
  }
  const need = ['axialStart', 'axialStep', 'clockStart', 'clockStep', 'pointNoBase'];
  for (const k of need) {
    if (!meta.has(k)) throw new Error(`C 扫描元信息缺少 #${k}`);
  }
  const sep = lines[dataStart]?.includes('\t') ? '\t' : ',';
  const header = splitCsvLine(lines[dataStart], sep);
  const cols = header.length - 1;
  const values: number[] = [];
  const badCells: ParsedCScan['badCells'] = [];
  let rows = 0;
  for (let i = dataStart + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = splitCsvLine(lines[i], sep);
    rows++;
    for (let c = 0; c < cols; c++) {
      const raw = (cells[c + 1] ?? '').trim();
      const v = Number(raw);
      if (raw === '' || !Number.isFinite(v)) {
        values.push(NaN);
        if (raw !== '') badCells.push({ row: rows - 1, col: c, raw, detail: '厚度无法解析' });
      } else {
        values.push(round3(v));
      }
    }
  }
  return {
    grid: {
      pointNoBase: String(meta.get('pointNoBase')),
      axialStart: Number(meta.get('axialStart')),
      axialStep: Number(meta.get('axialStep')),
      clockStart: Number(meta.get('clockStart')),
      clockStep: Number(meta.get('clockStep')),
      rows,
      cols,
      values,
    },
    badCells,
  };
}

function splitCsvLine(line: string, sep: string): string[] {
  if (sep === '\t') return line.split('\t');
  const out: string[] = [];
  let cur = '';
  let quote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quote && line[i + 1] === '"') { cur += '"'; i++; }
      else quote = !quote;
    } else if (ch === ',' && !quote) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function findHeader(header: string[], candidates: string[]): number {
  const lower = header.map((h) => h.toLowerCase().replace(/\s/g, ''));
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

function round3(x: number): number { return Math.round(x * 1000) / 1000; }
