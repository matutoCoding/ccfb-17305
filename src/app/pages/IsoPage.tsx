import { useState } from 'preact/hooks';
import { getState, selectPipeline } from '../../state/store';
import { repo, uid } from '../../db';
import { Card, Pill } from '../components';
import { View3D } from '../View3D';
import { Direction, Fitting, FittingKind } from '../../types';

const DIRS: Direction[] = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
const KINDS: { id: FittingKind; name: string }[] = [
  { id: 'PIPE', name: '直管' },
  { id: 'ELBOW', name: '弯头' },
  { id: 'TEE', name: '三通' },
  { id: 'REDUCER', name: '大小头' },
  { id: 'FLANGE', name: '法兰' },
  { id: 'VALVE', name: '阀门' },
];

export function IsoPage() {
  const s = getState();
  const { fittings, geometry, placementErrors } = s.bundle!;
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<Partial<Fitting>>({
    kind: 'PIPE', direction: '+X', length: 2000, elbowAngle: 90, elbowRadiusType: 'LR',
  });

  const issues = geometry.issues;
  const totalLen = geometry.mainTotalLength;

  const addFitting = async () => {
    const seq = fittings.length;
    const tag = form.tag || `${s.bundle!.pipeline.lineNo}-${form.kind?.[0] ?? 'F'}${String(seq + 1).padStart(2, '0')}`;
    const f: Fitting = {
      id: uid('fit'),
      pipelineId: s.selectedPipelineId!,
      seq,
      kind: form.kind ?? 'PIPE',
      length: Number(form.length ?? 1000),
      direction: form.direction ?? '+X',
      exitDirection: form.exitDirection,
      elbowAngle: form.elbowAngle,
      elbowRadiusType: form.elbowRadiusType,
      bendRadius: form.bendRadius,
      branchDirection: form.branchDirection,
      outletDiameter: form.outletDiameter,
      reducerType: form.reducerType,
      eccentricOffset: form.eccentricOffset,
      diameter: form.diameter,
      nominalDiameter: form.nominalDiameter ?? s.bundle!.pipeline.nominalDiameter,
      nominalWall: form.nominalWall ?? s.bundle!.pipeline.nominalWall,
      erosionFocus: form.erosionFocus,
      tag,
      remark: form.remark,
    };
    await repo.putFitting(f);
    await selectPipeline(s.selectedPipelineId!);
    setShowForm(false);
  };

  const removeFitting = async (id: string) => {
    await repo.deleteFitting(id);
    await selectPipeline(s.selectedPipelineId!);
  };

  return (
    <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
      <div className="sidebar" style={{ width: 420, flexBasis: 420 }}>
        <Card title={`管件走向（${fittings.length} 段，主管展开 ${totalLen.toLocaleString()} mm）`}
          extra={<button className="primary" onClick={() => setShowForm(!showForm)}>{showForm ? '收起' : '+ 录入管件'}</button>}>
          {showForm && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginBottom: 10 }}>
              <div className="grid2">
                <div className="field"><label>类型</label>
                  <select value={form.kind} onChange={(e) => setForm({ ...form, kind: (e.target as HTMLSelectElement).value as FittingKind })}>
                    {KINDS.map((k) => <option value={k.id}>{k.name}</option>)}
                  </select>
                </div>
                <div className="field"><label>编号 tag（可空自动）</label><input value={form.tag ?? ''} onInput={(e) => setForm({ ...form, tag: (e.target as HTMLInputElement).value })} /></div>
                <div className="field"><label>入口方向</label>
                  <select value={form.direction} onChange={(e) => setForm({ ...form, direction: (e.target as HTMLSelectElement).value as Direction })}>
                    {DIRS.map((d) => <option>{d}</option>)}
                  </select>
                </div>
                <div className="field"><label>长度/结构长度 mm</label><input type="number" value={form.length ?? 0} onInput={(e) => setForm({ ...form, length: Number((e.target as HTMLInputElement).value) })} /></div>
                {form.kind === 'ELBOW' && <>
                  <div className="field"><label>角度</label>
                    <select value={form.elbowAngle} onChange={(e) => setForm({ ...form, elbowAngle: Number((e.target as HTMLSelectElement).value) })}>
                      <option value={90}>90°</option><option value={45}>45°</option>
                    </select>
                  </div>
                  <div className="field"><label>半径类型</label>
                    <select value={form.elbowRadiusType} onChange={(e) => setForm({ ...form, elbowRadiusType: (e.target as HTMLSelectElement).value as 'LR' | 'SR' })}>
                      <option value="LR">长半径 LR (1.5DN)</option><option value="SR">短半径 SR (1.0DN)</option>
                    </select>
                  </div>
                  <div className="field"><label>出口方向</label>
                    <select value={form.exitDirection} onChange={(e) => setForm({ ...form, exitDirection: (e.target as HTMLSelectElement).value as Direction })}>
                      <option value="">（取下一段方向）</option>
                      {DIRS.map((d) => <option>{d}</option>)}
                    </select>
                  </div>
                </>}
                {form.kind === 'TEE' && (
                  <div className="field"><label>支管方向</label>
                    <select value={form.branchDirection} onChange={(e) => setForm({ ...form, branchDirection: (e.target as HTMLSelectElement).value as Direction })}>
                      {DIRS.map((d) => <option>{d}</option>)}
                    </select>
                  </div>
                )}
                {form.kind === 'REDUCER' && (
                  <div className="field"><label>出口外径 mm</label><input type="number" value={form.outletDiameter ?? ''} onInput={(e) => setForm({ ...form, outletDiameter: Number((e.target as HTMLInputElement).value) })} /></div>
                )}
                <div className="field"><label>冲刷重点</label>
                  <input type="checkbox" checked={!!form.erosionFocus} onChange={(e) => setForm({ ...form, erosionFocus: (e.target as HTMLInputElement).checked })} style={{ width: 16, height: 16 }} />
                </div>
              </div>
              <button className="primary" onClick={addFitting}>保存并重建三维</button>
            </div>
          )}
          <div style={{ maxHeight: '46%', overflow: 'auto' }}>
            <table>
              <thead><tr><th>#</th><th>编号</th><th>类型</th><th>方向</th><th>长度</th><th></th></tr></thead>
              <tbody>
                {fittings.map((f, i) => (
                  <tr key={f.id}>
                    <td>{i + 1}</td>
                    <td className="mono">{f.tag}{f.erosionFocus && <Pill kind="danger">冲刷</Pill>}</td>
                    <td>{f.kind}{f.kind === 'ELBOW' ? ` ${f.elbowAngle}°${f.elbowRadiusType === 'SR' ? ' SR' : ' LR'}` : ''}</td>
                    <td>{f.direction}{f.exitDirection ? `→${f.exitDirection}` : ''}</td>
                    <td>{f.length.toFixed(0)}</td>
                    <td><button className="danger ghost" onClick={() => removeFitting(f.id)}>删</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="建模校验">
          {issues.length === 0 && placementErrors.length === 0 ? (
            <div className="ok-text">✓ 走向连续，总长核对通过，测点落点全部有效</div>
          ) : (
            <>
              {issues.map((x: { level: string; code: string; message: string }) => (
                <div style={{ marginBottom: 6 }}>
                  <Pill kind={x.level === 'ERROR' ? 'danger' : 'warn'}>{x.code}</Pill>
                  <span style={{ marginLeft: 6 }}>{x.message}</span>
                </div>
              ))}
              {placementErrors.map((m) => (
                <div style={{ marginBottom: 6 }}><Pill kind="danger">POINT</Pill><span style={{ marginLeft: 6 }}>{m}</span></div>
              ))}
            </>
          )}
          {s.bundle!.pipeline.drawingTotalLength && (
            <div className="muted" style={{ marginTop: 8 }}>
              图纸总长 {s.bundle!.pipeline.drawingTotalLength}mm｜建模 {totalLen}mm｜
              偏差 {Math.abs(totalLen - s.bundle!.pipeline.drawingTotalLength).toFixed(1)}mm
            </div>
          )}
        </Card>
      </div>
      <View3D colorMode="PLAIN" opacity={1} />
    </div>
  );
}
