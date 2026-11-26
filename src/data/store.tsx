import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react'
import type {
  BadRow,
  CScanGrid,
  Fitting,
  ImportBatch,
  InspectionPeriod,
  Pipeline,
  Reading,
  ThicknessPoint
} from '../domain/types'
import * as db from './db'
import { generateSeed, SEED_VERSION } from './seed'

interface DataState {
  ready: boolean
  pipelines: Pipeline[]
  fittings: Fitting[]
  points: ThicknessPoint[]
  readings: Reading[]
  periods: InspectionPeriod[]
  cscans: CScanGrid[]
  badrows: BadRow[]
  batches: ImportBatch[]
}

interface DataApi extends DataState {
  savePipeline: (p: Pipeline) => Promise<void>
  deletePipeline: (id: string) => Promise<void>
  saveFitting: (f: Fitting) => Promise<void>
  deleteFitting: (id: string) => Promise<void>
  savePoint: (p: ThicknessPoint) => Promise<void>
  deletePoint: (id: string) => Promise<void>
  addReadings: (rs: Reading[]) => Promise<void>
  savePeriod: (p: InspectionPeriod) => Promise<void>
  saveCScan: (c: CScanGrid) => Promise<void>
  appendBadRows: (rows: BadRow[]) => Promise<void>
  removeBadRow: (id: string) => Promise<void>
  clearBadRows: () => Promise<void>
  saveBatch: (b: ImportBatch) => Promise<void>
  resetDemo: () => Promise<void>
  clearAll: () => Promise<void>
}

const Ctx = createContext<DataApi | null>(null)

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DataState>({
    ready: false,
    pipelines: [],
    fittings: [],
    points: [],
    readings: [],
    periods: [],
    cscans: [],
    badrows: [],
    batches: []
  })

  const load = useCallback(async () => {
    const [pipelines, fittings, points, readings, periods, cscans, badrows, batches] = await Promise.all([
      db.getAll<Pipeline>('pipelines'),
      db.getAll<Fitting>('fittings'),
      db.getAll<ThicknessPoint>('points'),
      db.getAll<Reading>('readings'),
      db.getAll<InspectionPeriod>('periods'),
      db.getAll<CScanGrid>('cscans'),
      db.getAll<BadRow>('badrows'),
      db.getAll<ImportBatch>('batches')
    ])
    setState({ ready: true, pipelines, fittings, points, readings, periods, cscans, badrows, batches })
  }, [])

  useEffect(() => {
    ;(async () => {
      const ver = await db.getMeta<string>('seedVersion')
      if (ver !== SEED_VERSION) {
        const seed = generateSeed()
        await db.bulkPut('pipelines', seed.pipelines)
        await db.bulkPut('fittings', seed.fittings)
        await db.bulkPut('points', seed.points)
        // 2.3 万读数分批写，避免单事务过大
        const CH = 4000
        for (let i = 0; i < seed.readings.length; i += CH) {
          await db.bulkPut('readings', seed.readings.slice(i, i + CH))
        }
        await db.bulkPut('periods', seed.periods)
        await db.bulkPut('cscans', seed.cscans)
        await db.bulkPut('badrows', seed.badrows)
        await db.setMeta('seedVersion', SEED_VERSION)
      }
      await load()
    })().catch((e) => {
      console.error('数据库初始化失败', e)
      // 即使 IDB 失败也用内存种子兜底，保证界面可演示
      const seed = generateSeed()
      setState({
        ready: true,
        pipelines: seed.pipelines,
        fittings: seed.fittings,
        points: seed.points,
        readings: seed.readings,
        periods: seed.periods,
        cscans: seed.cscans,
        badrows: seed.badrows,
        batches: []
      })
    })
  }, [load])

  const api = useMemo<DataApi>(() => {
    const mutate = async (fn: () => Promise<void>, patch: (s: DataState) => DataState) => {
      await fn()
      setState((s) => patch(s))
    }
    return {
      ...state,
      savePipeline: async (p) => {
        await db.put('pipelines', p)
        setState((s) => ({
          ...s,
          pipelines: s.pipelines.some((x) => x.id === p.id) ? s.pipelines.map((x) => (x.id === p.id ? p : x)) : [...s.pipelines, p]
        }))
      },
      deletePipeline: async (id) => {
        // 级联删除该线管件/点/读数
        const fits = state.fittings.filter((f) => f.pipelineId === id)
        const pts = state.points.filter((p) => p.pipelineId === id)
        await db.remove('pipelines', id)
        for (const f of fits) await db.remove('fittings', f.id)
        for (const p of pts) await db.remove('points', p.id)
        for (const r of state.readings.filter((r) => r.pipelineId === id)) await db.remove('readings', r.id)
        setState((s) => ({
          ...s,
          pipelines: s.pipelines.filter((x) => x.id !== id),
          fittings: s.fittings.filter((x) => x.pipelineId !== id),
          points: s.points.filter((x) => x.pipelineId !== id),
          readings: s.readings.filter((x) => x.pipelineId !== id)
        }))
      },
      saveFitting: async (f) =>
        mutate(
          () => db.put('fittings', f),
          (s) => ({
            ...s,
            fittings: s.fittings.some((x) => x.id === f.id)
              ? s.fittings.map((x) => (x.id === f.id ? f : x))
              : [...s.fittings, f]
          })
        ),
      deleteFitting: async (id) => {
        await db.remove('fittings', id)
        setState((s) => ({ ...s, fittings: s.fittings.filter((x) => x.id !== id) }))
      },
      savePoint: async (p) =>
        mutate(
          () => db.put('points', p),
          (s) => ({
            ...s,
            points: s.points.some((x) => x.id === p.id)
              ? s.points.map((x) => (x.id === p.id ? p : x))
              : [...s.points, p]
          })
        ),
      deletePoint: async (id) => {
        await db.remove('points', id)
        setState((s) => ({ ...s, points: s.points.filter((x) => x.id !== id), readings: s.readings.filter((r) => r.pointId !== id) }))
      },
      addReadings: async (rs) => {
        await db.bulkPut('readings', rs)
        setState((s) => ({ ...s, readings: [...s.readings, ...rs] }))
      },
      savePeriod: async (period) => {
        await db.put('periods', period)
        setState((s) => ({ ...s, periods: s.periods.some((x) => x.id === period.id) ? s.periods : [...s.periods, period] }))
      },
      saveCScan: async (cscan) => {
        await db.put('cscans', cscan)
        setState((s) => ({ ...s, cscans: [...s.cscans.filter((x) => x.id !== cscan.id), cscan] }))
      },
      appendBadRows: async (rows) => {
        await db.bulkPut('badrows', rows)
        setState((s) => ({ ...s, badrows: [...s.badrows, ...rows] }))
      },
      removeBadRow: async (id) => {
        await db.remove('badrows', id)
        setState((s) => ({ ...s, badrows: s.badrows.filter((x) => x.id !== id) }))
      },
      clearBadRows: async () => {
        await db.clearStore('badrows')
        setState((s) => ({ ...s, badrows: [] }))
      },
      saveBatch: async (b) => {
        await db.put('batches', b)
        setState((s) => ({ ...s, batches: [b, ...s.batches] }))
      },
      resetDemo: async () => {
        await db.clearAllData()
        const seed = generateSeed()
        await db.bulkPut('pipelines', seed.pipelines)
        await db.bulkPut('fittings', seed.fittings)
        await db.bulkPut('points', seed.points)
        const CH = 4000
        for (let i = 0; i < seed.readings.length; i += CH) await db.bulkPut('readings', seed.readings.slice(i, i + CH))
        await db.bulkPut('periods', seed.periods)
        await db.bulkPut('cscans', seed.cscans)
        await db.bulkPut('badrows', seed.badrows)
        await db.setMeta('seedVersion', SEED_VERSION)
        await load()
      },
      clearAll: async () => {
        await db.clearAllData()
        await load()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, load])

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

export function useData() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useData 必须在 DataProvider 内使用')
  return c
}

/** 某管线的管件（按 seq） */
export function useFittings(pipelineId?: string) {
  const { fittings } = useData()
  return useMemo(
    () => fittings.filter((f) => f.pipelineId === pipelineId).sort((a, b) => a.seq - b.seq),
    [fittings, pipelineId]
  )
}
