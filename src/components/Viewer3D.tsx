import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { ResolvedLine } from '../domain/geometry'
import { referenceToS } from '../domain/geometry'
import { useData } from '../data/store'
import { useSuspiciousSet } from '../state/selectors'
import { GpuLineRenderer } from '../viz/gpu-renderer'
import { buildCloudMesh, buildHardware, buildSphere, buildSectionRing } from '../viz/mesh'
import {
  buildMarkers,
  diffFieldSamples,
  makeRingEvaluator,
  periodThicknessMap,
  rateFieldSamples,
  thicknessFieldSamples,
  toGpuSamples,
  type MarkerVM
} from '../viz/line-view-model'
import { assessPoint, diffColor, rateColor, ratioColor, thicknessBasis } from '../domain/analysis'
import { projectWorld } from '../viz/camera'
import type { PlanItem } from '../domain/plan'
import { drawIsoCanvas } from '../viz/iso-drawing'

export type ViewMode = 'ratio' | 'long' | 'short' | 'diff'

export interface Viewer3DHandle {
  screenshot: () => string | null
}

interface Props {
  line: ResolvedLine
  mode: ViewMode
  periodId: string
  periodA?: string
  periodB?: string
  opacity: number
  selectedPointId?: string
  onSelectPoint?: (id: string | null) => void
  suggestions?: PlanItem[]
  showSuggestions?: boolean
  section?: { fittingId: string; sMm: number } | null
}

function css(c: [number, number, number], a = 1) {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`
}

export const Viewer3D = React.forwardRef<Viewer3DHandle, Props>(function Viewer3D(props, ref) {
  const { line, mode, periodId, periodA, periodB, opacity, selectedPointId, onSelectPoint, suggestions, showSuggestions, section } = props
  const data = useData()
  const susSet = useSuspiciousSet()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<GpuLineRenderer | null>(null)
  const [gpuState, setGpuState] = useState<'checking' | 'on' | 'off'>('checking')
  const markersRef = useRef<MarkerVM[]>([])
  const sugMarkersRef = useRef<MarkerVM[]>([])
  const dragRef = useRef<{ x: number; y: number; moved: number; button: number } | null>(null)

  const linePoints = useMemo(() => data.points.filter((p) => p.pipelineId === line.pipeline.id), [data.points, line.pipeline.id])
  const lineCscans = useMemo(() => data.cscans.filter((c) => c.pipelineId === line.pipeline.id), [data.cscans, line.pipeline.id])

  const tMin = useMemo(() => thicknessBasis(line.pipeline).tMin, [line.pipeline])
  const thicknessMap = useMemo(
    () => periodThicknessMap(data.readings, periodId as any, susSet),
    [data.readings, periodId, susSet]
  )

  const thickSamples = useMemo(
    () => thicknessFieldSamples(line, linePoints, thicknessMap, lineCscans, periodId as any),
    [line, linePoints, thicknessMap, lineCscans, periodId]
  )

  const displaySamples = useMemo(() => {
    if (mode === 'ratio') return thickSamples
    if (mode === 'long' || mode === 'short')
      return rateFieldSamples(line, linePoints, data.readings, mode === 'long' ? 'long' : 'short')
    return diffFieldSamples(line, linePoints, data.readings, periodA ?? 'per-2025', periodB ?? 'per-2026', susSet)
  }, [mode, thickSamples, line, linePoints, data.readings, periodA, periodB, susSet])

  // 测点颜色
  const markerColor = (ptId?: string): [number, number, number] => {
    if (!ptId) return [0.2, 0.8, 0.9]
    const pt = linePoints.find((p) => p.id === ptId)
    if (mode === 'ratio') {
      const v = thicknessMap.get(ptId)
      return v == null ? [0.6, 0.63, 0.7] : ratioColor(v / tMin)
    }
    if (mode === 'long' || mode === 'short') {
      const a = assessPoint(line.pipeline, ptId, data.readings)
      const r = mode === 'long' ? a.longRate : a.shortRate
      return r == null ? [0.6, 0.63, 0.7] : rateColor(r)
    }
    const a = periodThicknessMap(data.readings, periodA ?? 'per-2025', susSet).get(ptId)
    const b = periodThicknessMap(data.readings, periodB ?? 'per-2026', susSet).get(ptId)
    if (a == null || b == null) return [0.6, 0.63, 0.7]
    return diffColor(b - a)
  }

  const markers = useMemo(
    () =>
      buildMarkers(line, linePoints, (pt) => markerColor(pt.id), { selectedId: selectedPointId }).map((m) =>
        m.pointId === selectedPointId ? { ...m, size: m.size * 1.25 } : m
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [line, linePoints, thicknessMap, mode, selectedPointId, tMin, data.readings]
  )
  markersRef.current = markers

  const sugMarkers = useMemo<MarkerVM[]>(() => {
    if (!showSuggestions || !suggestions) return []
    const base = Math.max(13, Math.min(150, line.pipeline.outerDiameterMm * 0.2))
    return suggestions
      .filter((sg) => sg.pipelineId === line.pipeline.id)
      .map((sg) => {
        const rf = line.items.find((i) => i.fitting.id === sg.fittingId)!
        let pos = rf.locate(Math.min(sg.axialDistanceMm, rf.length), sg.clock).position
        if (sg.zone === 'tee_dead' && rf.branch) pos = rf.branch.end
        return {
          pos,
          color: sg.priority === 'high' ? [0.9, 0.15, 0.2] : [0.55, 0.3, 0.95],
          size: base,
          id: sg.id,
          suggestionId: sg.id
        }
      })
  }, [showSuggestions, suggestions, line])
  sugMarkersRef.current = sugMarkers

  // 初始化 WebGPU
  useEffect(() => {
    let alive = true
    const canvas = canvasRef.current!
    if (!GpuLineRenderer.supported()) {
      setGpuState('off')
      return
    }
    const r = new GpuLineRenderer(canvas)
    rendererRef.current = r
    r.init().then((ok) => {
      if (!alive) {
        r.dispose()
        return
      }
      setGpuState(ok ? 'on' : 'off')
      if (!ok) rendererRef.current = null
    })
    const ro = new ResizeObserver(() => r.resize())
    ro.observe(canvas)
    return () => {
      alive = false
      ro.disconnect()
      r.dispose()
      rendererRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 管线切换时重建几何 + 取景
  useEffect(() => {
    const r = rendererRef.current
    if (gpuState !== 'on' || !r) return
    const mesh = buildCloudMesh(line)
    r.setCloudMesh(mesh)
    r.setHardware(buildHardware(line))
    r.setSphere(buildSphere())
    r.camera.fitBounds(line.bounds.min, line.bounds.max)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpuState, line.pipeline.id])

  // 样本
  useEffect(() => {
    const r = rendererRef.current
    if (gpuState !== 'on' || !r) return
    r.setSamples(toGpuSamples(line, displaySamples))
  }, [gpuState, line, displaySamples])

  // 标记
  useEffect(() => {
    const r = rendererRef.current
    if (gpuState !== 'on' || !r) return
    r.setMarkers([...markers, ...sugMarkers])
  }, [gpuState, markers, sugMarkers])

  // 选项
  useEffect(() => {
    const r = rendererRef.current
    if (gpuState !== 'on' || !r) return
    r.setOptions({
      mode: mode === 'ratio' ? 0 : mode === 'diff' ? 2 : 1,
      opacity,
      tMin,
      maxRate: 1.2,
      clip: null
    })
  }, [gpuState, mode, opacity, tMin])

  // 剖面：clip + 圆环
  useEffect(() => {
    const r = rendererRef.current
    if (gpuState !== 'on' || !r) return
    if (!section) {
      r.setOptions({ clip: null })
      r.setRing(null)
      return
    }
    const rf = line.items.find((i) => i.fitting.id === section.fittingId)
    if (!rf) return
    const s = Math.max(0, Math.min(rf.length, section.sMm))
    const c = rf.centerAt(s)
    const evaluator = makeRingEvaluator(thickSamples)
    const ring = buildSectionRing(rf, s, (clock) => {
      const t = evaluator.thicknessAt(rf, s, clock)
      return ratioColor(t / tMin)
    })
    r.setRing(ring)
    r.setOptions({ clip: { point: c.p, tangent: c.t } })
  }, [gpuState, section, line, thickSamples, tMin])

  useImperativeHandle(ref, () => ({
    screenshot: () => rendererRef.current?.screenshot() ?? null
  }))

  // 指针交互
  const onPointerDown = (e: React.PointerEvent) => {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, moved: 0, button: e.button }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    const r = rendererRef.current
    if (!d || !r) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    d.moved += Math.abs(dx) + Math.abs(dy)
    d.x = e.clientX
    d.y = e.clientY
    if (d.button === 2 || e.shiftKey) r.camera.pan(dx, dy, canvasRef.current!.clientHeight)
    else r.camera.rotate(dx, dy)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d || d.moved > 6) return
    handleClick(e)
  }
  const onWheel = (e: React.WheelEvent) => {
    const r = rendererRef.current
    if (!r) return
    r.camera.zoom(e.deltaY > 0 ? 1.12 : 0.89)
  }

  const handleClick = (e: React.PointerEvent | React.MouseEvent) => {
    const r = rendererRef.current
    const canvas = canvasRef.current
    if (!r || !canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const w = rect.width
    const h = rect.height
    let best: { id?: string; sug?: string; d: number } | null = null
    for (const m of [...markersRef.current, ...sugMarkersRef.current]) {
      const p = projectWorld(r.camera.viewProj(), m.pos, w, h)
      if (!p.visible) continue
      const d = Math.hypot(p.x - x, p.y - y)
      if (d < 16 && (!best || d < best.d)) best = { id: m.pointId, sug: m.suggestionId, d }
    }
    if (best?.id) onSelectPoint?.(best.id)
    else if (best?.sug) {
      // 建议点点击：展开右侧建议（通过自定义事件）
      window.dispatchEvent(new CustomEvent('plan-suggestion-click', { detail: best.sug }))
    } else onSelectPoint?.(null)
  }

  if (gpuState === 'off') {
    return (
      <FallbackIso
        line={line}
        points={linePoints}
        selectedPointId={selectedPointId}
        onSelectPoint={onSelectPoint}
        suggestions={showSuggestions ? suggestions?.filter((s) => s.pipelineId === line.pipeline.id) : undefined}
      />
    )
  }

  return (
    <div className="viewer-wrap">
      <canvas
        ref={canvasRef}
        className="viewer-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      {gpuState === 'checking' && <div className="viewer-loading">正在初始化 WebGPU 计算着色器…</div>}
      <div className="viewer-hint">左键旋转 · 滚轮缩放 · 右键/Shift 平移 · 点击测点看历次读数</div>
      <Legend mode={mode} tMin={tMin} />
    </div>
  )
})

function Legend({ mode, tMin }: { mode: ViewMode; tMin: number }) {
  if (mode === 'ratio') {
    return (
      <div className="legend">
        <div className="legend-title">剩余壁厚 / 最小要求壁厚（tMin={tMin.toFixed(2)}）</div>
        <div className="legend-bar ratio" />
        <div className="legend-ticks">
          <span>&lt;1.0 低于下限</span>
          <span>1.2</span>
          <span>1.5</span>
          <span>2.0</span>
          <span>&gt;2 良好</span>
        </div>
      </div>
    )
  }
  if (mode === 'long' || mode === 'short') {
    return (
      <div className="legend">
        <div className="legend-title">{mode === 'long' ? '长期' : '短期'}腐蚀速率 mm/y（绿 0 → 红 ≥1.2）</div>
        <div className="legend-bar rate" />
      </div>
    )
  }
  return (
    <div className="legend">
      <div className="legend-title">两期厚度差（后期−前期）mm：红=减薄，蓝=增厚/可疑</div>
      <div className="legend-bar diff" />
    </div>
  )
}

/** WebGPU 不可用时的 Canvas2D 等轴测兼容视图，仍可点测点 */
function FallbackIso({
  line,
  points,
  selectedPointId,
  onSelectPoint,
  suggestions
}: {
  line: ResolvedLine
  points: any[]
  selectedPointId?: string
  onSelectPoint?: (id: string | null) => void
  suggestions?: PlanItem[]
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const hitsRef = useRef<{ pointId?: string; suggestionId?: string; x: number; y: number }[]>([])
  useEffect(() => {
    const c = ref.current!
    hitsRef.current = drawIsoCanvas(c, line, {
      dark: true,
      width: 1200,
      height: 760,
      points,
      suggestions,
      labelPointIds: new Set(selectedPointId ? [selectedPointId] : []),
      colorPoint: (pt) => {
        if (pt.id === selectedPointId) return '#ffffff'
        return pt.zone === 'elbow_outer' ? '#f97316' : pt.zone === 'elbow_inner' ? '#38bdf8' : '#34d399'
      }
    })
  }, [line, points, selectedPointId, suggestions])

  return (
    <div className="viewer-wrap">
      <canvas
        ref={ref}
        className="fallback-canvas"
        onClick={(e) => {
          const c = ref.current!
          const rect = c.getBoundingClientRect()
          const x = ((e.clientX - rect.left) / rect.width) * 1200
          const y = ((e.clientY - rect.top) / rect.height) * 760
          let best: (typeof hitsRef.current)[number] | null = null
          let bd = 1e9
          for (const h of hitsRef.current) {
            const d = Math.hypot(h.x - x, h.y - y)
            if (d < 14 && d < bd) {
              bd = d
              best = h
            }
          }
          if (best?.pointId) onSelectPoint?.(best.pointId)
          else onSelectPoint?.(null)
        }}
      />
      <div className="webgpu-warn">当前环境不支持 WebGPU，已显示等轴测兼容视图；GPU 连续云图/剖面请用最新 Chrome/Edge 开启硬件加速查看。</div>
    </div>
  )
}
