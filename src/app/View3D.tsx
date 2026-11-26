/**
 * 三维视图：装配 WebGPU 引擎（自动退化 Canvas2D），
 * 管面云图、测点标记、点击拾取历次读数、剖切圆环。
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { WebGpuEngine, ColorMode } from '../webgpu/engine';
import { FallbackRenderer } from '../webgpu/renderer-fallback';
import { buildTubeMesh, sectionRing, TubeMesh } from '../geometry/mesh';
import { placePoints } from '../geometry/placement';
import { getState, pointHistory, thicknessAt } from '../state/store';
import { PointPlacement } from '../types';
import { FittingDomain } from '../geometry/centerline';
import { FieldSample } from '../thickness/field';
import { fmt, fmtDate, Pill } from './components';

interface Props {
  colorMode: ColorMode;
  opacity: number;
  highlightFittingId?: string | null;
  highlightPointId?: string | null;
  cutFittingId?: string | null;
  onPickPoint?: (pointId: string | null) => void;
  registerEngine?: (api: View3dApi) => void;
}

export interface View3dApi {
  screenshot: () => Promise<Blob>;
  focusFitting: (fittingId: string) => void;
}

interface CutInfo {
  ring: ReturnType<typeof sectionRing>;
  colors: string[];
  dom: FittingDomain;
  s: number;
}

export function View3D(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<WebGpuEngine | null>(null);
  const fallbackRef = useRef<FallbackRenderer | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [webgpuOk, setWebgpuOk] = useState(true);
  const [cutS, setCutS] = useState(0.5);
  const state = getState();
  const bundle = state.bundle;

  const mesh = useMemo(() => {
    if (!bundle) return null;
    const map = new Map(bundle.fittings.map((f) => [f.id, f]));
    return buildTubeMesh(bundle.geometry, map);
  }, [bundle?.pipeline.id, bundle?.fittings.length]);

  const placements = useMemo<PointPlacement[]>(() => {
    if (!bundle) return [];
    return placePoints(bundle.geometry, bundle.points).placements;
  }, [bundle?.pipeline.id, bundle?.points.length]);

  // 场数据上传函数的稳定引用，引擎异步就绪后用它补传
  const uploadFieldsRef = useRef<((eng: WebGpuEngine) => void) | null>(null);

  // 初始化引擎
  useEffect(() => {
    let alive = true;
    async function boot() {
      if (!canvasRef.current || !mesh || !bundle) return;
      const currentMesh: TubeMesh = mesh;
      const bounds = meshBounds(currentMesh.positions);
      const tMinMap = new Map<string, number>();
      const nominalMap = new Map<string, number>();
      const geometryMeta = new Map<string, { sMax: number; radius: number }>();
      for (const f of bundle.fittings) {
        tMinMap.set(f.id, state.assessment?.fittingStats.find((x) => x.fittingId === f.id)?.tMin ?? 3);
        nominalMap.set(f.id, f.nominalWall ?? bundle.pipeline.nominalWall);
        const dom = bundle.geometry.domainByFitting.get(f.id);
        if (dom) geometryMeta.set(f.id, { sMax: dom.length, radius: dom.diameter / 2 });
      }
      const ok = await WebGpuEngine.isSupported();
      if (!ok) {
        setWebgpuOk(false);
        thisBootFallback();
        return;
      }
      let eng: WebGpuEngine;
      try {
        eng = new WebGpuEngine(canvasRef.current, {
          tMinByDomain: tMinMap, nominalByDomain: nominalMap, geometryMetaByDomain: geometryMeta,
        });
        await eng.init();
        eng.setMesh(currentMesh, bounds);
      } catch (err) {
        console.warn('WebGPU 初始化失败，回退 Canvas2D:', err);
        setWebgpuOk(false);
        thisBootFallback();
        return;
      }
      if (!alive) { eng.dispose(); return; }
      eng.setPickable(placements);
      eng.onPick = (id) => { setPicked(id); props.onPickPoint?.(id); };
      engineRef.current = eng;
      eng.setColorMode(props.colorMode);
      eng.setOpacity(props.opacity);
      // 引擎就绪时补传一次场数据，覆盖初始化期间错过的上传
      uploadFieldsRef.current?.(eng);
      props.registerEngine?.({
        screenshot: () => eng.screenshot(),
        focusFitting: (fid) => {
          const di = currentMesh.domainIndex.get(fid);
          if (di == null) return;
          const d = currentMesh.domains[di];
          const off = d.vertexOffset;
          const p = currentMesh.positions.slice(off * 3, off * 3 + 3);
          eng.camera.target = [p[0], p[1], p[2]];
          eng.render();
        },
      });
      eng.render();

      function thisBootFallback() {
        const fb = new FallbackRenderer(canvasRef.current!);
        fb.setMesh(currentMesh, bounds);
        fb.tMinByDomain = tMinMap;
        fb.setPickable(placements);
        fb.attachControls();
        fb.onPick = (id) => { setPicked(id); props.onPickPoint?.(id); };
        fallbackRef.current = fb;
        fb.start();
      }
    }
    void boot();
    return () => {
      alive = false;
      engineRef.current?.dispose();
      fallbackRef.current?.stop();
      engineRef.current = null;
      fallbackRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesh]);

  // 数据上传：引擎就绪后和每期场数据变化时都要跑，避免异步初始化导致的漏传
  const uploadFields = (eng: WebGpuEngine) => {    if (!bundle) return;
    const rounds = [...state.rounds].sort((a, b) => a.inspectDate - b.inspectDate);
    const latest = rounds[rounds.length - 1];
    const prev = rounds[rounds.length - 2];
    const latestField = latest ? state.fields.get(latest.id) : undefined;
    if (!latestField) return;
    eng.runInterpolation(latestField.samples, 'field');
    if (rounds.length >= 2) {
      const firstField = state.fields.get(rounds[0].id)!;
      const yearsLong = (latest.inspectDate - rounds[0].inspectDate) / (365.25 * 864e5);
      const yearsShort = (latest.inspectDate - prev.inspectDate) / (365.25 * 864e5);
      const rateLong = rateSamples(firstField.samples, latestField.samples, yearsLong);
      const rateShort = rateSamples(state.fields.get(prev.id)!.samples, latestField.samples, yearsShort);
      eng.runInterpolation(rateLong, 'rate');
      void rateShort;
      if (state.diff) {
        const diffSamples: FieldSample[] = state.diff.pointDiffs.map((d) => ({
          domainId: d.domainId, s: d.s, theta: d.theta, thickness: d.delta,
        }));
        eng.runInterpolation(diffSamples, 'diff');
      }
    }
    eng.render();
  };
  uploadFieldsRef.current = uploadFields;

  // 数据更新 -> 上传纹理（引擎可能仍在初始化，就绪回调里会补一次）
  useEffect(() => {
    const eng = engineRef.current;
    const fb = fallbackRef.current;
    if (!bundle || !mesh) return;
    const rounds = [...state.rounds].sort((a, b) => a.inspectDate - b.inspectDate);
    const latestField = rounds.length ? state.fields.get(rounds[rounds.length - 1].id) : undefined;
    if (eng && latestField) uploadFieldsRef.current?.(eng);
    if (fb && latestField) fb.setField(latestField);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.fields, state.assessment]);

  // 模式/透明度
  useEffect(() => {
    engineRef.current?.setColorMode(props.colorMode);
    engineRef.current?.setOpacity(props.opacity);
    engineRef.current?.render();
  }, [props.colorMode, props.opacity]);

  // 标记
  useEffect(() => {
    if (!bundle) return;
    const markers = buildMarkers(
      placements, bundle.points, picked, props.highlightPointId, props.highlightFittingId,
    );
    engineRef.current?.setMarkers(markers.map((m) => ({
      position: m.position, color: m.color, size: 6, id: m.id,
    })));
    fallbackRef.current?.setMarkers(markers.map((m) => ({
      position: m.position, color: rgbaCss(m.color), id: m.id,
    })));
    engineRef.current?.render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, props.highlightPointId, props.highlightFittingId, placements]);

  // 剖切圆环（用 CPU 壁厚场在 2D canvas 覆盖层绘制截面）
  const cutInfo: CutInfo | null = useMemo(() => {
    if (!props.cutFittingId || !bundle) return null;
    const dom = bundle.geometry.domainByFitting.get(props.cutFittingId);
    if (!dom) return null;
    const s = dom.length * cutS;
    const ring = sectionRing(dom, s, dom.nominalWall, 64);
    const colors: string[] = [];
    for (let i = 0; i < ring.theta.length; i++) {
      const t = thicknessAt(dom.fittingId, s, ring.theta[i]);
      const tMin = state.assessment?.fittingStats.find((x) => x.fittingId === dom.fittingId)?.tMin ?? 3;
      colors.push(ratioColor(Number.isFinite(t) ? t / tMin : -1));
    }
    return { ring, colors, dom, s };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.cutFittingId, cutS, state.fields, state.assessment]);

  const pickedPoint = bundle?.points.find((p) => p.id === picked);
  const history = picked ? pointHistory(picked) : [];

  return (
    <div className="viewport">
      <canvas ref={canvasRef} />
      {!webgpuOk && (
        <div style={{ position: 'absolute', top: 10, right: 10 }} className="tag-pill tag-warn">
          当前浏览器无 WebGPU，已切换 Canvas2D 模式
        </div>
      )}
      {props.cutFittingId && (
        <div style={{ position: 'absolute', right: 10, bottom: 10, width: 250,
          background: 'rgba(23,30,40,.95)', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
          <div className="muted" style={{ marginBottom: 6 }}>剖切位置（沿管轴向）</div>
          <input type="range" min={0.05} max={0.95} step={0.01} value={cutS}
            onInput={(e) => setCutS(Number((e.target as HTMLInputElement).value))} style={{ width: '100%' }} />
          <SectionRing info={cutInfo} />
        </div>
      )}
      {pickedPoint && (
        <div className="info-pop">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>{pickedPoint.pointNo}</strong>
            <button className="ghost" onClick={() => { setPicked(null); props.onPickPoint?.(null); }}>关闭</button>
          </div>
          <div className="muted" style={{ margin: '4px 0 8px' }}>
            管件 {bundle?.fittings.find((f) => f.id === pickedPoint.fittingId)?.tag}
            ｜轴向 {fmt(pickedPoint.axialDistance, 1)}mm｜钟点 {pickedPoint.clock}
            {pickedPoint.bendSide !== 'NONE' && `｜${pickedPoint.bendSide === 'EXTRADOS' ? '外弧' : pickedPoint.bendSide === 'INTRADOS' ? '内弧' : '侧弧'}`}
          </div>
          <table>
            <thead><tr><th>期次</th><th>日期</th><th>厚度 mm</th><th>状态</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr>
                  <td>{h.round.name}</td>
                  <td>{fmtDate(h.round.inspectDate)}</td>
                  <td className="mono">{fmt(h.thickness, 3)}</td>
                  <td>{h.suspicious ? <Pill kind="warn">增厚可疑</Pill> : <Pill kind="ok">正常</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(() => {
            const st = state.assessment?.pointStats.find((x) => x.pointId === picked);
            if (!st) return null;
            return (
              <div className="grid2" style={{ marginTop: 8 }}>
                <div><div className="muted">最小要求壁厚</div><div className="mono">{fmt(st.tMin, 2)} mm</div></div>
                <div><div className="muted">剩余寿命</div><div className="mono">{Number.isFinite(st.remainingLifeYears) ? `${fmt(st.remainingLifeYears, 1)} 年` : '充足'}</div></div>
                <div><div className="muted">长期速率</div><div className="mono">{fmt(st.longTermRate, 3)} mm/a</div></div>
                <div><div className="muted">短期速率</div><div className="mono">{fmt(st.shortTermRate, 3)} mm/a</div></div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function SectionRing(props: { info: CutInfo | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const info = props.info;
    if (!cv || !info) return;
    const ctx = cv.getContext('2d')!;
    const W = cv.width = 220;
    const H = cv.height = 220;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H / 2;
    // 按 θ 画环带（截面正对屏幕示意，颜色取自真实壁厚场）
    const rOut = 90;
    const rIn = 62;
    for (let i = 0; i < info.colors.length; i++) {
      const a0 = (i / info.colors.length) * Math.PI * 2 - Math.PI / 2;
      const a1 = ((i + 1) / info.colors.length) * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, rOut, a0, a1);
      ctx.arc(cx, cy, rIn, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = info.colors[i];
      ctx.fill();
    }
    ctx.fillStyle = '#0b0f15';
    ctx.beginPath();
    ctx.arc(cx, cy, rIn, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#8ea0b5';
    ctx.beginPath();
    ctx.arc(cx, cy, rOut, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#8ea0b5';
    ctx.font = '10px sans-serif';
    ctx.fillText('12点', cx - 10, cy - rOut - 4);
    ctx.fillText('6点', cx - 8, cy + rOut + 14);
  }, [props.info]);
  return <canvas ref={ref} style={{ width: 220, height: 220 }} />;
}

// 仅用于类型占位
function meshBounds(pos: Float32Array) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pos[i + k]);
      max[k] = Math.max(max[k], pos[i + k]);
    }
  }
  return { min, max };
}

function rateSamples(first: FieldSample[], last: FieldSample[], years: number): FieldSample[] {
  const key = (s: FieldSample) => `${s.domainId}|${s.s.toFixed(2)}|${s.theta.toFixed(4)}`;
  const map = new Map(first.map((s) => [key(s), s]));
  const out: FieldSample[] = [];
  for (const s of last) {
    const old = map.get(key(s));
    if (!old) continue;
    out.push({ ...s, thickness: Math.max(0, (old.thickness - s.thickness) / years) });
  }
  return out;
}

function buildMarkers(
  placements: PointPlacement[],
  points: { id: string; fittingId: string; bendSide: string }[],
  picked: string | null,
  highlightPoint: string | null | undefined,
  highlightFitting: string | null | undefined,
) {
  const ptMap = new Map(points.map((p) => [p.id, p]));
  return placements.map((pl) => {
    const pt = ptMap.get(pl.pointId);
    let color: [number, number, number, number] = [1, 0.85, 0.2, 1];
    if (pt?.bendSide === 'EXTRADOS') color = [1, 0.35, 0.35, 1];
    if (pl.pointId === picked || pl.pointId === highlightPoint) color = [0.3, 1, 0.5, 1];
    if (highlightFitting && pt?.fittingId === highlightFitting) color = [0.4, 0.8, 1, 1];
    return { id: pl.pointId, position: pl.position, color };
  });
}

function rgbaCss(c: number[]): string {
  return `rgba(${c.map((x, i) => i < 3 ? Math.round(x * 255) : x).join(',')})`;
}

function ratioColor(ratio: number): string {
  if (ratio < 0) return 'rgb(158,158,168)';
  const stops: [number, [number, number, number]][] = [
    [0.4, [212, 31, 31]], [0.7, [242, 115, 26]], [0.9, [242, 204, 38]],
    [1.1, [89, 191, 76]], [1.4, [51, 140, 217]],
  ];
  let c = stops[stops.length - 1][1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (ratio <= stops[i + 1][0]) {
      const [r0, c0] = stops[i];
      const [r1, c1] = stops[i + 1];
      const f = Math.max(0, (ratio - r0) / (r1 - r0));
      c = [Math.round(c0[0] + (c1[0] - c0[0]) * f), Math.round(c0[1] + (c1[1] - c0[1]) * f), Math.round(c0[2] + (c1[2] - c0[2]) * f)];
      break;
    }
  }
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
