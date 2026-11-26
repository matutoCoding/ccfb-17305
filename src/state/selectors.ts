import { useMemo } from 'react'
import { useData } from '../data/store'
import { resolveLine, type ResolvedLine } from '../domain/geometry'
import { computeSuspicious } from '../domain/analysis'

export function useResolvedLines(): ResolvedLine[] {
  const { pipelines, fittings } = useData()
  return useMemo(
    () =>
      pipelines.map((p) =>
        resolveLine(
          p,
          fittings.filter((f) => f.pipelineId === p.id)
        )
      ),
    [pipelines, fittings]
  )
}

export function useResolvedLine(pipelineId?: string): ResolvedLine | undefined {
  const lines = useResolvedLines()
  return useMemo(() => lines.find((l) => l.pipeline.id === pipelineId), [lines, pipelineId])
}

/** 全局可疑读数 id 集合（按点用同一规则计算，三维/列表/导入共用） */
export function useSuspiciousSet(): Set<string> {
  const { readings } = useData()
  return useMemo(() => {
    const byPoint = new Map<string, typeof readings>()
    for (const r of readings) {
      if (!byPoint.has(r.pointId)) byPoint.set(r.pointId, [])
      byPoint.get(r.pointId)!.push(r)
    }
    const all = new Set<string>()
    for (const rs of byPoint.values()) {
      for (const id of computeSuspicious(rs)) all.add(id)
    }
    return all
  }, [readings])
}
