import { useState, useRef } from 'preact/hooks';
import { getState } from '../../state/store';
import { Card, Pill, fmt, fmtDate } from '../components';
import { FittingStat } from '../../thickness/life';
import { View3D, View3dApi } from '../View3D';

export function LifePage() {
  const s = getState();
  const a = s.assessment!;
  const [focus, setFocus] = useState<string | null>(null);
  const [show3d, setShow3d] = useState(false);
  const [tab, setTab] = useState<'fitting' | 'point'>('fitting');

  const rlPill = (rl: number) =>
    !Number.isFinite(rl) ? <Pill kind="ok">充足</Pill>
      : rl < 3 ? <Pill kind="danger">{fmt(rl, 1)} 年</Pill>
      : rl < 8 ? <Pill kind="warn">{fmt(rl, 1)} 年</Pill>
      : <Pill kind="ok">{fmt(rl, 1)} 年</Pill>;

  const jump = (st: FittingStat) => {
    setFocus(st.fittingId);
    setShow3d(true);
  };

  return (
    <div className="content scroll">
      <div className="grid3" style={{ marginBottom: 12 }}>
        <Card title="设计温度许用应力 S"><div className="stat-num">{fmt(a.allowableStress, 1)} <span className="muted" style={{ fontSize: 12 }}>MPa</span></div></Card>
        <Card title="最不利管件">
          <div className="stat-num" style={{ fontSize: 15 }}>{a.worstFitting?.tag ?? '—'}</div>
          <div className="muted">{a.worstFitting ? `剩余寿命 ${fmt(a.worstFitting.remainingLifeYears, 1)} 年` : ''}</div>
        </Card>
        <Card title="管件超标数量">
          <div className="stat-num">{a.fittingStats.filter((f) => Number.isFinite(f.remainingLifeYears) && f.remainingLifeYears < 10).length}</div>
          <div className="muted">剩余寿命低于 10 年</div>
        </Card>
      </div>

      <div className="row" style={{ marginBottom: 8 }}>
        <button className={tab === 'fitting' ? 'primary' : 'ghost'} onClick={() => setTab('fitting')}>管件级评估（每条管线取最不利点）</button>
        <button className={tab === 'point' ? 'primary' : 'ghost'} onClick={() => setTab('point')}>测点级明细</button>
      </div>

      {tab === 'fitting' && (
        <Card title="管件寿命评估（点行跳转三维位置）">
          <table>
            <thead>
              <tr><th>管件编号</th><th>类型</th><th>tmin mm</th><th>当前最小 mm</th><th>最薄位置</th>
                <th>长期速率</th><th>短期速率</th><th>取用速率</th><th>剩余寿命</th><th>下次检验</th><th>三维</th></tr>
            </thead>
            <tbody>
              {[...a.fittingStats]
                .sort((x, y) => (Number.isFinite(x.remainingLifeYears) ? x.remainingLifeYears : 9999) - (Number.isFinite(y.remainingLifeYears) ? y.remainingLifeYears : 9999))
                .map((st) => (
                  <tr key={st.fittingId} style={{ cursor: 'pointer' }} onClick={() => jump(st)}>
                    <td className="mono">{st.tag}{st.erosionFocus && <Pill kind="danger">冲刷</Pill>}</td>
                    <td>{st.kind}</td>
                    <td className="mono">{fmt(st.tMin, 2)}</td>
                    <td className="mono">{fmt(st.minThickness, 2)}</td>
                    <td className="mono">{st.minPointNo || '—'}</td>
                    <td className="mono">{fmt(st.longTermRate, 3)}</td>
                    <td className="mono">{fmt(st.shortTermRate, 3)}</td>
                    <td className="mono">{fmt(st.governingRate, 3)}</td>
                    <td>{rlPill(st.remainingLifeYears)}</td>
                    <td>{fmtDate(st.nextInspectionDate)}</td>
                    <td><button className="ghost" onClick={(e) => { e.stopPropagation(); jump(st); }}>定位 →</button></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Card>
      )}

      {tab === 'point' && (
        <Card title="测点级寿命明细">
          <table>
            <thead>
              <tr><th>点号</th><th>内/外弧</th><th>最新厚度</th><th>tmin</th><th>长期</th><th>短期</th><th>剩余寿命</th><th>状态</th></tr>
            </thead>
            <tbody>
              {a.pointStats.map((st) => (
                <tr key={st.pointId}>
                  <td className="mono">{st.pointNo}</td>
                  <td>{st.bendSide === 'EXTRADOS' ? '外弧' : st.bendSide === 'INTRADOS' ? '内弧' : st.bendSide === 'SIDE' ? '侧弧' : '—'}</td>
                  <td className="mono">{fmt(st.latestThickness, 3)}</td>
                  <td className="mono">{fmt(st.tMin, 2)}</td>
                  <td className="mono">{fmt(st.longTermRate, 3)}</td>
                  <td className="mono">{fmt(st.shortTermRate, 3)}</td>
                  <td>{rlPill(st.remainingLifeYears)}</td>
                  <td>{st.suspicious ? <Pill kind="warn">增厚可疑</Pill> : <Pill kind="ok">正常</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {show3d && (
        <div style={{ position: 'fixed', inset: 40, zIndex: 50, background: 'var(--bg)',
          border: '1px solid var(--border)', borderRadius: 10, display: 'flex', flexDirection: 'column' }}>
          <div className="row" style={{ padding: 10, borderBottom: '1px solid var(--border)' }}>
            <strong>三维定位 — {s.bundle!.fittings.find((f) => f.id === focus)?.tag}</strong>
            <div className="flex-spacer" />
            <button className="ghost" onClick={() => setShow3d(false)}>关闭</button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <MapPageWrapper focusFitting={focus} />
          </div>
        </div>
      )}
    </div>
  );
}

/** 弹窗内复用三维视图（保持同一套云图与数据源） */
function MapPageWrapper(props: { focusFitting: string | null }) {
  const [api, setApi] = useState<View3dApi | null>(null);
  const focused = useRef<string | null>(null);
  if (api && props.focusFitting && focused.current !== props.focusFitting) {
    focused.current = props.focusFitting;
    api.focusFitting(props.focusFitting);
  }
  return <View3D colorMode="RATIO" opacity={1} highlightFittingId={props.focusFitting} registerEngine={setApi} />;
}
