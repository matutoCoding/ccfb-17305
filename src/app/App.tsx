import { useEffect, useState } from 'preact/hooks';
import { ensureSeed, reloadPipelines, selectPipeline, subscribe, getState, reseedDemo } from '../state/store';
import { PipelinePage } from './pages/PipelinePage';
import { IsoPage } from './pages/IsoPage';
import { ThicknessDataPage } from './pages/ThicknessDataPage';
import { MapPage } from './pages/MapPage';
import { LifePage } from './pages/LifePage';
import { PlanPage } from './pages/PlanPage';

export type Tab = 'pipeline' | 'iso' | 'data' | 'map' | 'life' | 'plan';

const TABS: { id: Tab; name: string }[] = [
  { id: 'pipeline', name: '管线档案' },
  { id: 'iso', name: '等轴测建模' },
  { id: 'data', name: '测厚数据' },
  { id: 'map', name: '三维减薄图' },
  { id: 'life', name: '寿命评估' },
  { id: 'plan', name: '检验计划' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('map');
  const [, force] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = subscribe(() => force((n) => n + 1));
    void (async () => {
      await ensureSeed();
      await reloadPipelines();
      const s = getState();
      if (s.pipelines[0]) await selectPipeline(s.pipelines[0].id);
      setLoading(false);
    })();
    return unsub;
  }, []);

  const s = getState();
  const selected = s.pipelines.find((p) => p.id === s.selectedPipelineId);

  return (
    <div className="app">
      <div className="topbar">
        <h1>管道定点测厚三维减薄分析系统</h1>
        <span className="sub">TypeScript + WebGPU + IndexedDB</span>
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.name}
            </button>
          ))}
        </div>
        <div className="flex-spacer" />
        <button className="ghost" onClick={async () => {
          if (confirm('重新生成演示数据将覆盖当前库，确认？')) {
            setLoading(true);
            await reseedDemo();
            setLoading(false);
          }
        }}>重置演示数据</button>
      </div>
      <div className="main">
        <div className="sidebar">
          <div className="muted" style={{ padding: '4px 6px 8px' }}>
            管线 {s.pipelines.length} 条｜管件 {s.bundle?.fittings.length ?? 0} 个｜测点 {s.bundle?.points.length ?? 0} 个
          </div>
          {s.pipelines.map((p) => (
            <div
              key={p.id}
              className={`line-item ${p.id === s.selectedPipelineId ? 'selected' : ''}`}
              onClick={() => selectPipeline(p.id)}
            >
              <div className="no">{p.lineNo}</div>
              <div className="meta">{p.subUnit}｜DN{p.nominalDiameter} {p.wallSchedule}｜{p.service}</div>
            </div>
          ))}
        </div>
        {loading ? (
          <div className="content">正在初始化 IndexedDB 演示数据…</div>
        ) : !selected ? (
          <div className="content">请先在左侧选择一条管线</div>
        ) : (
          <div className="full-content">
            {tab === 'pipeline' && <PipelinePage />}
            {tab === 'iso' && <IsoPage />}
            {tab === 'data' && <ThicknessDataPage />}
            {tab === 'map' && <MapPage />}
            {tab === 'life' && <LifePage />}
            {tab === 'plan' && <PlanPage />}
          </div>
        )}
      </div>
    </div>
  );
}
