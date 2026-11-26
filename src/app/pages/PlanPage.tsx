import { useState } from 'preact/hooks';
import { getState, suggestedPointPosition } from '../../state/store';
import { Card, Pill, fmtDate } from '../components';
import { View3D, View3dApi } from '../View3D';

export function PlanPage() {
  const s = getState();
  const plan = s.plan!;
  const [active, setActive] = useState(plan.items[0]?.fittingId ?? null);
  const [api, setApi] = useState<View3dApi | null>(null);
  const [shot, setShot] = useState<string | null>(null);

  const activeItem = plan.items.find((i) => i.fittingId === active);

  const exportTaskSheet = async () => {
    let dataUrl = shot;
    if (!dataUrl && api) {
      const blob = await api.screenshot();
      dataUrl = await blobToDataUrl(blob);
      setShot(dataUrl);
    }
    const rows = plan.items.flatMap((it) =>
      it.suggestedPoints.map((sp) => ({
        管线号: s.bundle!.pipeline.lineNo,
        管件编号: it.tag,
        建议点号: sp.pointNo,
        钟点: sp.clock.toFixed(1),
        轴向距离mm: sp.s.toFixed(1),
        内外弧: sp.bendSide === 'EXTRADOS' ? '外弧' : sp.bendSide === 'INTRADOS' ? '内弧' : sp.bendSide === 'SIDE' ? '侧弧' : '—',
        依据: sp.reason,
        风险等级: it.riskLevel,
        下次检验日期: fmtDate(it.nextInspectionDate),
      })));
    const csv = '﻿' + [
      Object.keys(rows[0] ?? { 管线号: '' }).join(','),
      ...rows.map((r) => Object.values(r).map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')),
    ].join('\n');

    // 带等轴测截图的 HTML 任务单（可直接打印/另存 PDF）
    const html = buildTaskHtml(plan.items, s.bundle!.pipeline.lineNo, dataUrl);
    download(`${s.bundle!.pipeline.lineNo}-测厚任务单.csv`, new Blob([csv], { type: 'text/csv' }));
    download(`${s.bundle!.pipeline.lineNo}-测厚任务单.html`, new Blob([html], { type: 'text/html' }));
  };

  return (
    <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
      <div className="sidebar" style={{ width: 460, flexBasis: 460, overflow: 'auto' }}>
        <Card title={`检验计划（周期 ${plan.inspectionCycleYears} 年，${plan.items.length} 个管件需关注）`}
          extra={<button className="primary" onClick={exportTaskSheet}>导出任务单</button>}>
          {plan.items.map((it) => (
            <div key={it.fittingId}
              className={`line-item ${it.fittingId === active ? 'selected' : ''}`}
              onClick={() => { setActive(it.fittingId); setShot(null); }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong className="mono">{it.tag}</strong>
                {it.riskLevel === 'HIGH' ? <Pill kind="danger">高风险</Pill> : <Pill kind="warn">中风险</Pill>}
              </div>
              <div className="meta" style={{ marginTop: 4 }}>
                {it.kind}｜现有测点 {it.existingPointCount}｜外弧覆盖 {it.extradosCovered ? '是' : '否'}
                ｜下次检验 {fmtDate(it.nextInspectionDate)}
              </div>
              {it.reasons.map((r) => <div className="warn-text" style={{ fontSize: 12 }}>• {r}</div>)}
              {it.suggestedPoints.length > 0 && (
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  建议加点 {it.suggestedPoints.length} 个：
                  {it.suggestedPoints.map((sp) => ` ${sp.pointNo}(钟点${sp.clock.toFixed(1)})`).join('，')}
                </div>
              )}
            </div>
          ))}
        </Card>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <View3D colorMode="RATIO" opacity={0.85} highlightFittingId={active} registerEngine={setApi} />
        {activeItem && (
          <div style={{ position: 'absolute', bottom: 10, left: 10, right: 270,
            background: 'rgba(23,30,40,.95)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
            <strong>{activeItem.tag} 建议加点三维落点</strong>
            <table style={{ marginTop: 6 }}>
              <thead><tr><th>建议点号</th><th>钟点</th><th>轴向 mm</th><th>部位</th><th>落点坐标 (x,y,z)</th><th>依据</th></tr></thead>
              <tbody>
                {activeItem.suggestedPoints.map((sp) => {
                  const pos = suggestedPointPosition(sp.fittingId, sp.s, sp.theta);
                  return (
                    <tr key={sp.pointNo}>
                      <td className="mono">{sp.pointNo}</td>
                      <td>{sp.clock.toFixed(1)}</td>
                      <td>{sp.s.toFixed(1)}</td>
                      <td>{sp.bendSide === 'EXTRADOS' ? '外弧' : sp.bendSide === 'SIDE' ? '侧弧' : '—'}</td>
                      <td className="mono">{pos ? pos.position.map((x) => x.toFixed(0)).join(', ') : '—'}</td>
                      <td className="muted">{sp.reason}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function buildTaskHtml(
  items: ReturnType<typeof getState>['plan'] extends infer _ ? any[] : never,
  lineNo: string,
  shot: string | null,
): string {
  const rows = items.flatMap((it: any) => it.suggestedPoints.map((sp: any) => `
    <tr><td>${it.tag}</td><td>${sp.pointNo}</td><td>${sp.clock.toFixed(1)}</td>
    <td>${sp.s.toFixed(1)}</td><td>${sp.bendSide === 'EXTRADOS' ? '外弧' : sp.bendSide === 'SIDE' ? '侧弧' : '—'}</td>
    <td>${sp.reason}</td><td></td><td></td></tr>`)).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${lineNo} 测厚任务单</title>
  <style>
    body{font-family:'Microsoft YaHei',sans-serif;padding:24px;color:#222}
    h2{margin:0 0 4px} table{border-collapse:collapse;width:100%;margin-top:12px;font-size:13px}
    th,td{border:1px solid #888;padding:6px 8px;text-align:left} th{background:#eee}
    img{max-width:100%;border:1px solid #aaa;border-radius:6px;margin-top:14px}
    .muted{color:#666;font-size:12px}
  </style></head><body>
  <h2>${lineNo} 定点测厚任务单</h2>
  <div class="muted">生成时间 ${new Date().toLocaleString('zh-CN')}｜末两列留作实测厚度与检测人签字</div>
  <table><thead><tr><th>管件编号</th><th>建议点号</th><th>钟点</th><th>轴向距离mm</th><th>部位</th><th>依据</th><th>实测厚度</th><th>检测人</th></tr></thead>
  <tbody>${rows}</tbody></table>
  ${shot ? `<img src="${shot}" alt="等轴测截图" /><div class="muted">等轴测三维截图（云图：剩余壁厚/最小要求壁厚）</div>` : ''}
  </body></html>`;
}
