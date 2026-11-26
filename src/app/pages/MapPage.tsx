import { useState } from 'preact/hooks';
import { getState } from '../../state/store';
import { View3D, View3dApi } from '../View3D';
import { ColorMode } from '../../webgpu/engine';

const MODES: { id: ColorMode; name: string }[] = [
  { id: 'RATIO', name: '剩余壁厚/最小要求' },
  { id: 'RATE_LONG', name: '长期腐蚀速率' },
  { id: 'RATE_SHORT', name: '短期腐蚀速率' },
  { id: 'DIFF', name: '两期差值云图' },
  { id: 'PLAIN', name: '原色' },
];

export function MapPage() {
  const s = getState();
  const [mode, setMode] = useState<ColorMode>('RATIO');
  const [opacity, setOpacity] = useState(1);
  const [cutFitting, setCutFitting] = useState<string | null>(null);
  const [api, setApi] = useState<View3dApi | null>(null);
  const { fittings } = s.bundle!;

  return (
    <div className="full-content" style={{ position: 'relative' }}>
      <View3D
        colorMode={mode}
        opacity={opacity}
        cutFittingId={cutFitting}
        registerEngine={setApi}
      />
      <div className="view-toolbar">
        {MODES.map((m) => (
          <button key={m.id} className={mode === m.id ? 'active' : ''} onClick={() => setMode(m.id)}>{m.name}</button>
        ))}
        <span style={{ alignSelf: 'center', color: 'var(--muted)', margin: '0 6px' }}>|</span>
        <label style={{ alignSelf: 'center', color: 'var(--muted)' }}>
          外壁透明度
          <input type="range" min={0.15} max={1} step={0.05} value={opacity}
            onInput={(e) => setOpacity(Number((e.target as HTMLInputElement).value))} style={{ width: 90, verticalAlign: 'middle' }} />
        </label>
        <select value={cutFitting ?? ''} onChange={(e) => setCutFitting((e.target as HTMLSelectElement).value || null)}>
          <option value="">剖切：关闭</option>
          {fittings.map((f) => <option value={f.id}>{f.tag}（{f.kind}）</option>)}
        </select>
      </div>
      <Legend mode={mode} />
      <div style={{ position: 'absolute', left: 10, bottom: 10 }} className="muted">
        左键拖拽旋转｜滚轮缩放｜点击测点查看历次读数
        {api && <span>｜镜头聚焦可由寿命评估/检验计划行触发</span>}
      </div>
    </div>
  );
}

function Legend(props: { mode: ColorMode }) {
  if (props.mode === 'PLAIN') return null;
  if (props.mode === 'DIFF') {
    return (
      <div className="legend">
        <div>两期差值（后-前, mm）</div>
        <div className="bar" style={{ background: 'linear-gradient(90deg, rgb(217,26,26), rgb(255,242,230), rgb(38,89,229))' }} />
        <div className="row" style={{ justifyContent: 'space-between' }}><span>-1.5 减薄</span><span>0</span><span>+0.5 增厚可疑</span></div>
      </div>
    );
  }
  if (props.mode === 'RATE_LONG' || props.mode === 'RATE_SHORT') {
    return (
      <div className="legend">
        <div>{props.mode === 'RATE_LONG' ? '长期' : '短期'}腐蚀速率 mm/a</div>
        <div className="bar" style={{ background: 'linear-gradient(90deg, rgb(51,115,230), rgb(242,204,38), rgb(230,38,31))' }} />
        <div className="row" style={{ justifyContent: 'space-between' }}><span>0</span><span>0.25</span><span>≥0.5</span></div>
      </div>
    );
  }
  return (
    <div className="legend">
      <div>剩余壁厚 / 最小要求壁厚</div>
      <div className="bar" style={{ background: 'linear-gradient(90deg, rgb(212,31,31), rgb(242,115,26), rgb(242,204,38), rgb(89,191,76), rgb(51,140,217))' }} />
      <div className="row" style={{ justifyContent: 'space-between' }}><span>≤0.4</span><span>0.9</span><span>≥1.3</span></div>
      <div className="muted" style={{ marginTop: 6, lineHeight: 1.6 }}>
        灰色=该域无实测数据，不以名义壁厚冒充实测；插值严格限制在同一管件内，不跨法兰/焊口。
      </div>
    </div>
  );
}
