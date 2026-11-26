import React, { useState } from 'react'
import { useData } from './data/store'
import { NavProvider, type PageKey, type NavParams, type NavState } from './state/nav'
import { Toaster } from './components/Toast'
import PipelinesPage from './pages/PipelinesPage'
import IsometricPage from './pages/IsometricPage'
import DataPage from './pages/DataPage'
import ViewerPage from './pages/ViewerPage'
import LifePage from './pages/LifePage'
import PlanPage from './pages/PlanPage'
import { GpuLineRenderer } from './viz/gpu-renderer'

const NAV: { key: PageKey; label: string; ico: string; sub: string }[] = [
  { key: 'pipelines', label: '管线档案', ico: '🗂️', sub: '装置/单元/管线号与材质规格' },
  { key: 'isometric', label: '等轴测建模', ico: '📐', sub: '一段段录入走向并自动扫掠三维' },
  { key: 'data', label: '测厚数据', ico: '📊', sub: '测点台账 / CSV 导入 / 坏行 / C 扫' },
  { key: 'viewer', label: '三维减薄图', ico: '🧊', sub: '表面距离 GPU 插值云图与剖刀' },
  { key: 'life', label: '寿命评估', ico: '⏳', sub: 'API 570 速率 / 剩余寿命 / 检测日期' },
  { key: 'plan', label: '检验计划', ico: '📝', sub: '覆盖不足识别与加点任务单' }
]

export default function App() {
  const { ready, resetDemo } = useData()
  const [page, setPage] = useState<PageKey>('pipelines')
  const [params, setParams] = useState<NavParams>({})

  const nav: NavState = {
    page,
    params,
    go: (p, prm = {}) => {
      setPage(p)
      setParams(prm)
    }
  }

  if (!ready) {
    return (
      <div className="loading-screen">
        <div style={{ textAlign: 'center' }}>
          <div className="spinner" />
          正在初始化 IndexedDB 并生成常减压演示数据（27 条管线 / 3 千余管件 / 2 万余读数）…
        </div>
      </div>
    )
  }

  const current = NAV.find((n) => n.key === page)!
  const gpu = GpuLineRenderer.supported()

  return (
    <NavProvider value={nav}>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-logo">🛢️</div>
            <div>
              <div className="brand-title">管道定点测厚<br />三维减薄分析系统</div>
              <div className="brand-sub">THICKNESS 3D · API 570</div>
            </div>
          </div>
          {NAV.map((n) => (
            <button key={n.key} className={`nav-item ${page === n.key ? 'active' : ''}`} onClick={() => nav.go(n.key)}>
              <span className="ico">{n.ico}</span>
              {n.label}
            </button>
          ))}
          <div className="side-foot">
            <div>
              <span className={`gpu-dot ${gpu ? 'on' : 'off'}`} />
              {gpu ? 'WebGPU 计算着色器可用' : 'WebGPU 不可用 · 兼容等轴测视图'}
            </div>
            <div>数据仅存本机 IndexedDB</div>
            <button
              className="btn sm"
              style={{ background: 'rgba(148,163,184,.15)', color: '#cbd5e1', border: '1px solid rgba(148,163,184,.25)' }}
              onClick={async () => {
                if (confirm('重置为内置演示数据？')) {
                  await resetDemo()
                  location.reload()
                }
              }}
            >
              ↻ 重置演示数据
            </button>
          </div>
        </aside>

        <main className="main">
          <header className="topbar">
            <div>
              <h1>{current.label}</h1>
              <div className="crumb">{current.sub}</div>
            </div>
          </header>
          <div className="content">
            {page === 'pipelines' && <PipelinesPage />}
            {page === 'isometric' && <IsometricPage initialPipelineId={params.pipelineId} />}
            {page === 'data' && <DataPage initialPipelineId={params.pipelineId} />}
            {page === 'viewer' && <ViewerPage params={params} />}
            {page === 'life' && <LifePage initialPipelineId={params.pipelineId} />}
            {page === 'plan' && <PlanPage initialPipelineId={params.pipelineId} />}
          </div>
        </main>
        <Toaster />
      </div>
    </NavProvider>
  )
}
