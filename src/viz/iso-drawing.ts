import type { ThicknessPoint } from '../domain/types'
import type { ResolvedLine } from '../domain/geometry'
import { OrbitCamera, projectWorld } from './camera'
import { referenceToS } from '../domain/geometry'
import type { PlanItem } from '../domain/plan'

export interface IsoDrawOptions {
  width?: number
  height?: number
  points?: ThicknessPoint[]
  labelPointIds?: Set<string>
  colorPoint?: (pt: ThicknessPoint) => string
  suggestions?: PlanItem[]
  title?: string
  subtitle?: string
  dark?: boolean
  highlightFittingId?: string
}

export interface IsoHit {
  pointId?: string
  suggestionId?: string
  x: number
  y: number
}

/** 把一条解析后的管线画成等轴测示意图（也用于测厚任务单截图） */
export function drawIsoCanvas(canvas: HTMLCanvasElement, line: ResolvedLine, opts: IsoDrawOptions = {}): IsoHit[] {
  const hits: IsoHit[] = []
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const W = opts.width ?? 1400
  const H = opts.height ?? 900
  canvas.width = W * dpr
  canvas.height = H * dpr
  canvas.style.width = '100%'
  canvas.style.height = 'auto'
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)

  const dark = opts.dark ?? false
  ctx.fillStyle = dark ? '#0c1220' : '#ffffff'
  ctx.fillRect(0, 0, W, H)

  const cam = new OrbitCamera()
  cam.aspect = W / H
  cam.fitBounds(line.bounds.min, line.bounds.max)
  cam.yaw = -0.82
  cam.pitch = 0.52
  cam.distance *= 1.12
  const vp = cam.viewProj()
  const P = (p: [number, number, number]) => projectWorld(vp, p, W, H)

  // 管道像素宽度按外径/投影比例估算
  const origin = P([0, 0, 0])
  const odP = P([line.pipeline.outerDiameterMm, 0, 0])
  const pxPerMm = Math.abs(odP.x - origin.x) / line.pipeline.outerDiameterMm || 0.05
  const pipeW = Math.max(5, line.pipeline.outerDiameterMm * pxPerMm * 0.5)

  // 管道：外描边 + 浅色管体 + 中心线
  const drawPath = (width: number, color: string, dash?: number[]) => {
    ctx.beginPath()
    let started = false
    for (const rf of line.items) {
      const steps = rf.isElbow ? 24 : 2
      for (let i = 0; i <= steps; i++) {
        const s = (rf.length * i) / steps
        const pr = P(rf.centerAt(s).p)
        if (!pr.visible) continue
        if (!started) {
          ctx.moveTo(pr.x, pr.y)
          started = true
        } else ctx.lineTo(pr.x, pr.y)
      }
    }
    ctx.lineWidth = width
    ctx.strokeStyle = color
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.setLineDash(dash ?? [])
    ctx.stroke()
    ctx.setLineDash([])
  }

  drawPath(pipeW + 2, dark ? '#000000' : '#94a3b8')
  drawPath(pipeW, dark ? '#3b4a63' : '#e2e8f0')
  drawPath(1, dark ? '#7dd3fc' : '#64748b', [10, 6])

  // 选中管件高亮
  if (opts.highlightFittingId) {
    const rf = line.items.find((i) => i.fitting.id === opts.highlightFittingId)
    if (rf) {
      ctx.beginPath()
      const steps = rf.isElbow ? 30 : 2
      for (let i = 0; i <= steps; i++) {
        const s = (rf.length * i) / steps
        const pr = P(rf.centerAt(s).p)
        if (i === 0) ctx.moveTo(pr.x, pr.y)
        else ctx.lineTo(pr.x, pr.y)
      }
      ctx.lineWidth = pipeW + 5
      ctx.strokeStyle = 'rgba(220,38,38,0.35)'
      ctx.lineCap = 'round'
      ctx.stroke()
      ctx.lineWidth = 3
      ctx.strokeStyle = '#dc2626'
      ctx.stroke()
    }
  }

  // 管件编号（只标弯头/三通/阀门/大小头，避免密集）
  ctx.font = '12px "Segoe UI", sans-serif'
  ctx.textAlign = 'left'
  for (const rf of line.items) {
    if (rf.kind === 'pipe' || rf.kind === 'flange') continue
    const mid = rf.centerAt(rf.length / 2).p
    const p = P(mid)
    if (!p.visible) continue
    const label = rf.code.split('-').slice(-1)[0]
    ctx.fillStyle = dark ? 'rgba(125,211,252,0.9)' : '#0369a1'
    ctx.fillText(label, p.x + 6, p.y - 6)
  }

  // 测点
  if (opts.points) {
    for (const pt of opts.points) {
      if (pt.pipelineId !== line.pipeline.id) continue
      const rf = line.items.find((i) => i.fitting.id === pt.fittingId)
      if (!rf) continue
      const { s } = referenceToS(rf, pt.reference, pt.axialDistanceMm)
      const L = rf.locate(s, pt.clock)
      const p = P(L.position)
      if (!p.visible) continue
      const color = opts.colorPoint?.(pt) ?? '#0ea5e9'
      ctx.beginPath()
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = '#fff'
      ctx.stroke()
      hits.push({ pointId: pt.id, x: p.x, y: p.y })
      if (opts.labelPointIds?.has(pt.id)) {
        ctx.font = 'bold 13px "Segoe UI", sans-serif'
        ctx.fillStyle = dark ? '#fde68a' : '#92400e'
        ctx.fillText(pt.code, p.x + 7, p.y - 7)
      }
    }
  }

  // 建议加点：紫色菱形 + 编号
  if (opts.suggestions) {
    opts.suggestions.forEach((sg, i) => {
      const rf = line.items.find((x) => x.fitting.id === sg.fittingId)
      if (!rf) return
      let pos: [number, number, number]
      if (sg.zone === 'tee_dead' && rf.branch) pos = rf.branch.end
      else pos = rf.locate(Math.min(sg.axialDistanceMm, rf.length), sg.clock).position
      const p = P(pos)
      const r = 9
      ctx.beginPath()
      ctx.moveTo(p.x, p.y - r)
      ctx.lineTo(p.x + r, p.y)
      ctx.lineTo(p.x, p.y + r)
      ctx.lineTo(p.x - r, p.y)
      ctx.closePath()
      ctx.fillStyle = sg.priority === 'high' ? '#dc2626' : '#7c3aed'
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.font = 'bold 12px "Segoe UI", sans-serif'
      ctx.fillStyle = dark ? '#fff' : '#111'
      ctx.fillText(String(i + 1), p.x - 3.5, p.y + 4)
      hits.push({ suggestionId: sg.id, x: p.x, y: p.y })
    })
  }

  // 标题栏
  ctx.textAlign = 'left'
  ctx.fillStyle = dark ? '#e2e8f0' : '#0f172a'
  ctx.font = 'bold 26px "Segoe UI", sans-serif'
  ctx.fillText(opts.title ?? line.pipeline.code, 28, 42)
  ctx.font = '15px "Segoe UI", sans-serif'
  ctx.fillStyle = dark ? '#94a3b8' : '#475569'
  ctx.fillText(
    opts.subtitle ??
      `${line.pipeline.block} · ${line.pipeline.medium} · DN${line.pipeline.dn} ${line.pipeline.schedule} · OD${line.pipeline.outerDiameterMm} · t_nom ${line.pipeline.nominalWallMm}mm`,
    28,
    68
  )

  // 坐标轴
  drawAxis(ctx, P, W - 90, H - 90)

  // 角标
  ctx.font = '12px "Segoe UI", sans-serif'
  ctx.fillStyle = dark ? '#64748b' : '#94a3b8'
  ctx.textAlign = 'right'
  ctx.fillText('等轴测示意（钟点基准：顺流向，12=正上方）', W - 20, H - 18)

  return hits
}

function drawAxis(
  ctx: CanvasRenderingContext2D,
  P: (p: Vec3Like) => { x: number; y: number },
  x: number,
  y: number
) {
  const o = P([0, 0, 0])
  const ax = P([600, 0, 0])
  const ay = P([0, 600, 0])
  const az = P([0, 0, 600])
  // 以固定小原点重画在右下角比较麻烦，这里直接用投影方向画三轴
  const base = { x, y }
  const vec = (q: { x: number; y: number }) => {
    const dx = q.x - o.x
    const dy = q.y - o.y
    const l = Math.hypot(dx, dy) || 1
    return { x: base.x + (dx / l) * 34, y: base.y + (dy / l) * 34 }
  }
  const axes: [ReturnType<typeof vec>, string, string][] = [
    [vec(ax), 'X', '#ef4444'],
    [vec(ay), 'Y↑', '#22c55e'],
    [vec(az), 'Z', '#3b82f6']
  ]
  for (const [e, label, color] of axes) {
    ctx.beginPath()
    ctx.moveTo(base.x, base.y)
    ctx.lineTo(e.x, e.y)
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.fillStyle = color
    ctx.font = 'bold 12px sans-serif'
    ctx.fillText(label, e.x + 3, e.y + 3)
  }
  ctx.beginPath()
  ctx.arc(base.x, base.y, 3, 0, Math.PI * 2)
  ctx.fillStyle = '#334155'
  ctx.fill()
}

type Vec3Like = [number, number, number]

export function isoDataURL(line: ResolvedLine, opts: IsoDrawOptions = {}): string {
  const canvas = document.createElement('canvas')
  drawIsoCanvas(canvas, line, opts)
  return canvas.toDataURL('image/png')
}
