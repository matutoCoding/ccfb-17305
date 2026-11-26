import { useState } from 'preact/hooks';
import { getState, reloadPipelines } from '../../state/store';
import { lookupNominalWall, lookupOuterDiameter, MATERIALS, PIPE_DIMENSIONS } from '../../standards';
import { repo, uid } from '../../db';
import { Card, Pill } from '../components';
import { Pipeline } from '../../types';

export function PipelinePage() {
  const s = getState();
  const p = s.bundle!.pipeline;
  const [draft, setDraft] = useState<Pipeline>(p);
  const [msg, setMsg] = useState('');

  const update = (patch: Partial<Pipeline>) => {
    const next = { ...draft, ...patch };
    // 公称直径/壁厚等级变化自动带出外径与名义壁厚
    if (patch.nominalDiameter !== undefined || patch.wallSchedule !== undefined) {
      const od = lookupOuterDiameter(next.nominalDiameter);
      const wall = lookupNominalWall(next.nominalDiameter, next.wallSchedule);
      if (od) next.outerDiameter = od;
      if (wall) next.nominalWall = wall;
    }
    setDraft(next);
  };

  const save = async () => {
    await repo.putPipeline({ ...draft, updatedAt: Date.now() });
    await reloadPipelines();
    setMsg('档案已保存');
    setTimeout(() => setMsg(''), 2000);
  };

  return (
    <div className="content scroll">
      <div className="grid2">
        <Card title="管线档案">
          <div className="grid2">
            <div className="field"><label>装置</label><input value={draft.unit} onInput={(e) => update({ unit: (e.target as HTMLInputElement).value })} /></div>
            <div className="field"><label>单元</label><input value={draft.subUnit} onInput={(e) => update({ subUnit: (e.target as HTMLInputElement).value })} /></div>
            <div className="field"><label>管线号</label><input value={draft.lineNo} onInput={(e) => update({ lineNo: (e.target as HTMLInputElement).value })} /></div>
            <div className="field"><label>介质</label><input value={draft.service} onInput={(e) => update({ service: (e.target as HTMLInputElement).value })} /></div>
            <div className="field">
              <label>公称直径 DN</label>
              <select value={draft.nominalDiameter} onChange={(e) => update({ nominalDiameter: Number((e.target as HTMLSelectElement).value) })}>
                {Object.values(PIPE_DIMENSIONS).map((d) => <option value={d.dn}>DN{d.dn}</option>)}
              </select>
            </div>
            <div className="field">
              <label>壁厚等级</label>
              <select value={draft.wallSchedule} onChange={(e) => update({ wallSchedule: (e.target as HTMLSelectElement).value })}>
                {Object.keys(PIPE_DIMENSIONS[draft.nominalDiameter]?.schedules ?? {}).map((sc) => <option>{sc}</option>)}
              </select>
            </div>
            <div className="field"><label>外径 mm（自动带出）</label><input value={draft.outerDiameter} disabled /></div>
            <div className="field"><label>名义壁厚 mm（自动带出）</label><input value={draft.nominalWall} disabled /></div>
            <div className="field"><label>设计压力 MPa</label><input type="number" step="0.01" value={draft.designPressure} onInput={(e) => update({ designPressure: Number((e.target as HTMLInputElement).value) })} /></div>
            <div className="field"><label>操作压力 MPa</label><input type="number" step="0.01" value={draft.operatingPressure} onInput={(e) => update({ operatingPressure: Number((e.target as HTMLInputElement).value) })} /></div>
            <div className="field"><label>设计温度 ℃</label><input type="number" value={draft.designTemp} onInput={(e) => update({ designTemp: Number((e.target as HTMLInputElement).value) })} /></div>
            <div className="field"><label>操作温度 ℃</label><input type="number" value={draft.operatingTemp} onInput={(e) => update({ operatingTemp: Number((e.target as HTMLInputElement).value) })} /></div>
            <div className="field">
              <label>材质</label>
              <select value={draft.material} onChange={(e) => update({ material: (e.target as HTMLSelectElement).value })}>
                {Object.keys(MATERIALS).map((m) => <option>{m}</option>)}
              </select>
            </div>
            <div className="field"><label>腐蚀裕量 mm</label><input type="number" step="0.1" value={draft.corrosionAllowance} onInput={(e) => update({ corrosionAllowance: Number((e.target as HTMLInputElement).value) })} /></div>
            <div className="field"><label>焊接接头系数 E</label><input type="number" step="0.05" value={draft.weldJointEfficiency} onInput={(e) => update({ weldJointEfficiency: Number((e.target as HTMLInputElement).value) })} /></div>
            <div className="field"><label>图纸总长 mm（核对用，可空）</label><input type="number" value={draft.drawingTotalLength ?? ''} onInput={(e) => update({ drawingTotalLength: Number((e.target as HTMLInputElement).value) || undefined })} /></div>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" onClick={save}>保存档案</button>
            {msg && <span className="ok-text">{msg}</span>}
          </div>
        </Card>

        <div>
          <Card title="同装置管线一览">
            <table>
              <thead><tr><th>管线号</th><th>单元</th><th>规格</th><th>材质</th><th>介质</th></tr></thead>
              <tbody>
                {s.pipelines.map((x) => (
                  <tr key={x.id}>
                    <td className="mono">{x.lineNo}</td>
                    <td>{x.subUnit}</td>
                    <td>DN{x.nominalDiameter}×{x.nominalWall}</td>
                    <td>{x.material}</td>
                    <td>{x.service}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="建档说明">
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--muted)', lineHeight: 1.9 }}>
              <li>选择 DN 与壁厚等级后，外径与名义壁厚按 ASME B36.10M 自动带出，可手工覆盖。</li>
              <li>最小要求壁厚在「寿命评估」页按 B31.3 内压公式 + 腐蚀裕量实时计算。</li>
              <li>新管线可复制现有档案后改管线号，id 自动生成。</li>
            </ul>
            <button className="ghost" style={{ marginTop: 8 }} onClick={async () => {
              const copy: Pipeline = {
                ...draft, id: uid('pl'), lineNo: `${draft.lineNo}-COPY`,
                createdAt: Date.now(), updatedAt: Date.now(),
              };
              await repo.putPipeline(copy);
              await reloadPipelines();
            }}>复制为新管线</button>
          </Card>
          <Card title="数据完整性">
            <div className="row">
              <Pill kind="ok">管件 {s.bundle!.fittings.length}</Pill>
              <Pill kind="ok">测点 {s.bundle!.points.length}</Pill>
              <Pill kind={s.badRows.length ? 'warn' : 'ok'}>导入坏行 {s.badRows.length}</Pill>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
