/**
 * 应用全局状态：管线/管件/测点/读数的加载与派生计算。
 * 三维拾取与表格导出共用同一份 assessment/field 结果，数字天然一致。
 */
import {
  BadRow, CScanGrid, Fitting, InspectionRound, Pipeline,
  ThicknessPoint, ThicknessReading,
} from '../types';
import { repo, uid } from '../db';
import { PipelineGeometry, buildGeometry, bendSideTheta, placeOnSurface } from '../geometry/centerline';
import { placePoints } from '../geometry/placement';
import { buildField, FieldSample, ThicknessField, lookupGrid } from '../thickness/field';
import { assess, PipelineAssessment, FittingStat } from '../thickness/life';
import { diffRounds, DiffResult } from '../thickness/diff';
import { buildInspectionPlan, InspectionPlan } from '../thickness/inspection';
import { thetaToClock } from '../math/vector';

export interface PipelineBundle {
  pipeline: Pipeline;
  fittings: Fitting[];
  points: ThicknessPoint[];
  geometry: PipelineGeometry;
  placementErrors: string[];
}

export interface AppState {
  ready: boolean;
  pipelines: Pipeline[];
  selectedPipelineId: string | null;
  rounds: InspectionRound[];
  bundle: PipelineBundle | null;
  fields: Map<string, ThicknessField>; // roundId -> field
  assessment: PipelineAssessment | null;
  diff: DiffResult | null;
  plan: InspectionPlan | null;
  cscans: CScanGrid[];
  badRows: BadRow[];
}

type Listener = (s: AppState) => void;

let state: AppState = {
  ready: false,
  pipelines: [],
  selectedPipelineId: null,
  rounds: [],
  bundle: null,
  fields: new Map(),
  assessment: null,
  diff: null,
  plan: null,
  cscans: [],
  badRows: [],
};
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l({ ...state, fields: new Map(state.fields) });
}

export function subscribe(l: Listener): () => boolean {
  listeners.add(l);
  l(state);
  return () => listeners.delete(l);
}

export function getState(): AppState {
  return state;
}

async function setState(patch: Partial<AppState>) {
  state = { ...state, ...patch };
  emit();
}

/** 首启灌入演示数据 */
export async function ensureSeed(force = false) {
  const seeded = await repo.getMeta<boolean>('seeded');
  if (seeded && !force) return;
  const resp = await fetch('/demo-seed.json');
  const seed = await resp.json();
  for (const p of seed.pipelines as Pipeline[]) await repo.putPipeline(p);
  await repo.putFittings(seed.fittings as Fitting[]);
  await repo.putPoints(seed.points as ThicknessPoint[]);
  for (const r of seed.rounds as InspectionRound[]) await repo.putRound(r);
  await repo.addReadings(seed.readings as ThicknessReading[]);
  await repo.addBadRows(seed.badRows as BadRow[]);
  for (const c of seed.cscans as CScanGrid[]) await repo.putCScan(c);
  await repo.setMeta('seeded', true);
  await reloadPipelines();
}

export async function reseedDemo() {
  await repo.setMeta('seeded', false);
  await ensureSeed(true);
}

export async function reloadPipelines() {
  const pipelines = await repo.listPipelines();
  const rounds = await repo.listRounds();
  const badRows = await repo.listBadRows();
  const cscans = await repo.listCScan();
  await setState({ pipelines, rounds, badRows, cscans, ready: true });
  if (state.selectedPipelineId) await selectPipeline(state.selectedPipelineId);
}

export async function selectPipeline(id: string) {
  const pipeline = await repo.getPipeline(id);
  if (!pipeline) return;
  const fittings = await repo.listFittings(id);
  fittings.sort((a, b) => a.seq - b.seq);
  const points = await repo.listPoints(id);
  const geometry = buildGeometry(pipeline, fittings);
  const placed = placePoints(geometry, points);
  await setState({
    selectedPipelineId: id,
    bundle: {
      pipeline,
      fittings,
      points,
      geometry,
      placementErrors: placed.errors.map((e) => e.message),
    },
    fields: new Map(),
    assessment: null,
    diff: null,
    plan: null,
  });
  await recompute();
}

/** 汇总某管线各期读数与 C 扫描，构建壁厚场并做评估 */
export async function recompute() {
  const b = state.bundle;
  if (!b) return;
  const allReadings = await repo.allReadings();
  const rounds = [...state.rounds].sort((a, b2) => a.inspectDate - b2.inspectDate);
  const pointById = new Map(b.points.map((p) => [p.pointNo, p]));
  const placed = placePoints(b.geometry, b.points);
  const cscans = state.cscans.filter((c) => b.fittings.some((f) => f.id === c.fittingId));

  const fields = new Map<string, ThicknessField>();
  // pointId -> roundId -> 读数（可疑标记在两期对比后回填）
  const readingMap = new Map<string, Map<string, { thickness: number; suspicious: boolean }>>();
  const latestRound = rounds[rounds.length - 1];

  for (const round of rounds) {
    const samples: FieldSample[] = [];
    for (const r of allReadings.filter((x) => x.roundId === round.id)) {
      const pt = pointById.get(r.pointNo);
      if (!pt) continue;
      const prm = placed.paramsByPoint.get(pt.id);
      if (!prm) continue;
      samples.push({
        domainId: prm.domainId, s: prm.s, theta: prm.theta,
        thickness: r.thickness, pointNo: pt.pointNo,
      });
      if (!readingMap.has(pt.id)) readingMap.set(pt.id, new Map());
      readingMap.get(pt.id)!.set(round.id, { thickness: r.thickness, suspicious: false });
    }
    // C 扫描网格贴到弯头曲面
    for (const grid of cscans.filter((c) => c.roundId === round.id)) {
      const dom = b.geometry.domainByFitting.get(grid.fittingId);
      if (!dom) continue;
      for (let r2 = 0; r2 < grid.rows; r2++) {
        for (let c = 0; c < grid.cols; c++) {
          const v = grid.values[r2 * grid.cols + c];
          if (!Number.isFinite(v)) continue;
          const s = grid.axialStart + r2 * grid.axialStep;
          const clock = grid.clockStart + c * grid.clockStep;
          const theta = ((clock % 12) / 12) * Math.PI * 2;
          samples.push({ domainId: grid.fittingId, s, theta, thickness: v, pointNo: `${grid.pointNoBase}-C${r2}_${c}` });
        }
      }
    }
    fields.set(round.id, buildField(b.geometry.domains, samples));
  }

  // 两期对比：可疑增厚点
  let diff: DiffResult | null = null;
  if (rounds.length >= 2) {
    const prev = rounds[rounds.length - 2];
    const next = latestRound;
    diff = diffRounds(
      { roundId: prev.id, field: fields.get(prev.id)! },
      { roundId: next.id, field: fields.get(next.id)! },
    );
    const suspiciousKeys = new Set(diff.pointDiffs.filter((d) => d.suspicious).map((d) => `${d.domainId}|${d.s}|${d.theta}`));
    for (const pt of b.points) {
      const prm = placed.paramsByPoint.get(pt.id);
      if (!prm) continue;
      const key = `${prm.domainId}|${prm.s}|${prm.theta}`;
      if (suspiciousKeys.has(key)) {
        readingMap.get(pt.id)?.get(next.id) && (readingMap.get(pt.id)!.get(next.id)!.suspicious = true);
      }
    }
  }

  const latestGrids = new Map(fields.get(latestRound.id)!.grids);
  const assessment = assess({
    pipeline: b.pipeline,
    fittings: b.fittings,
    points: b.points,
    rounds,
    readings: readingMap,
    latestGrids,
    latestRoundId: latestRound.id,
    now: Date.now(),
  });
  const plan = buildInspectionPlan(
    b.fittings, b.geometry.domains, b.points, assessment.fittingStats, Date.now(), 5,
  );
  await setState({ fields, assessment, diff, plan });
}

/** 查某测点在某期的厚度（三维拾取用，与评估表同一数据源） */
export function pointHistory(pointId: string): { round: InspectionRound; thickness: number; suspicious: boolean }[] {
  const b = state.bundle;
  if (!b) return [];
  const pt = b.points.find((p) => p.id === pointId);
  if (!pt) return [];
  const out: { round: InspectionRound; thickness: number; suspicious: boolean }[] = [];
  for (const field of state.fields) {
    const [roundId, f] = field;
    const round = state.rounds.find((r) => r.id === roundId);
    const sp = f.samples.find((s) => s.pointNo === pt.pointNo);
    if (round && sp) {
      const d = state.diff?.pointDiffs.find((x) => x.pointNo === pt.pointNo);
      out.push({ round, thickness: sp.thickness, suspicious: !!d?.suspicious });
    }
  }
  return out.sort((a, b2) => a.round.inspectDate - b2.round.inspectDate);
}

/** 管件 -> 最新期最小厚度（检验计划/导出与三维同源） */
export function fittingStat(fittingId: string): FittingStat | undefined {
  return state.assessment?.fittingStats.find((f) => f.fittingId === fittingId);
}

/** 任意 (域,s,θ) 在最新期的壁厚 —— 剖切圆环与拾取共用 */
export function thicknessAt(domainId: string, s: number, theta: number): number {
  const rounds = [...state.rounds].sort((a, b) => a.inspectDate - b.inspectDate);
  const last = rounds[rounds.length - 1];
  if (!last) return NaN;
  const field = state.fields.get(last.id);
  const grid = field?.grids.get(domainId);
  const dom = state.bundle?.geometry.domainByFitting.get(domainId);
  if (!grid || !dom) return NaN;
  return lookupGrid(grid, s, theta);
}

/** 建议加点的三维落点（检验计划页 -> 三维高亮） */
export function suggestedPointPosition(fittingId: string, s: number, theta: number) {
  const dom = state.bundle?.geometry.domainByFitting.get(fittingId);
  if (!dom) return null;
  const p = placeOnSurface(dom, s, theta);
  return { position: p.position, normal: p.normal, clock: thetaToClock(theta) };
}

export { bendSideTheta, uid };
