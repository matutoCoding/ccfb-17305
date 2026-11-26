import type { ResolvedLine } from './geometry'
import type { PlanItem } from './plan'
import { downloadTextFile, toCsv } from './life-table'
import { NOW } from './now'

/** 导出测厚任务单 CSV（点位编号/位置/建议） */
export function exportTaskCsv(line: ResolvedLine, items: PlanItem[]) {
  const rows = toCsv([
    ['序号', '管线号', '管件编号', '建议点编号', '区域', '钟点', '轴向距离mm', '基准端面', '优先级', '建议原因'],
    ...items.map((it, i) => [
      i + 1,
      it.pipelineCode,
      it.fittingCode,
      `ADD-${String(i + 1).padStart(3, '0')}`,
      zoneLabel(it.zone),
      it.clock.toFixed(1),
      Math.round(it.axialDistanceMm),
      refLabel(it.reference),
      it.priority === 'high' ? '高' : it.priority === 'medium' ? '中' : '低',
      it.reasonDetail
    ])
  ])
  downloadTextFile(`${line.pipeline.code}_测厚任务单.csv`, rows, 'text/csv;charset=utf-8')
}

export function zoneLabel(z: string) {
  return (
    {
      elbow_outer: '弯头外弧',
      elbow_inner: '弯头内弧',
      tee_dead: '三通盲端',
      injection_downstream: '注水点下游',
      normal: '一般部位'
    } as Record<string, string>
  )[z] ?? z
}

export function refLabel(r: string) {
  return (
    {
      upstream_weld: '上游焊口',
      downstream_weld: '下游焊口',
      fitting_start: '管件起点',
      fitting_end: '管件终点'
    } as Record<string, string>
  )[r] ?? r
}

/** 生成并下载带等轴测截图 + 点位编号的可打印 HTML 任务单 */
export function exportTaskHtml(line: ResolvedLine, items: PlanItem[], isoPng: string) {
  const p = line.pipeline
  const rows = items
    .map(
      (it, i) => `<tr>
      <td class="c">${i + 1}</td>
      <td><b>ADD-${String(i + 1).padStart(3, '0')}</b></td>
      <td>${it.fittingCode}</td>
      <td>${zoneLabel(it.zone)}</td>
      <td class="c">${it.clock.toFixed(1)} 点</td>
      <td class="c">${Math.round(it.axialDistanceMm)}</td>
      <td>${refLabel(it.reference)}</td>
      <td class="c pr-${it.priority}">${it.priority === 'high' ? '高' : it.priority === 'medium' ? '中' : '低'}</td>
      <td>${it.reasonDetail}</td>
    </tr>`
    )
    .join('')

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<title>${p.code} 测厚任务单</title>
<style>
  body{font-family:"Microsoft YaHei","Segoe UI",sans-serif;color:#0f172a;margin:32px;}
  h1{font-size:22px;margin:0 0 4px} .sub{color:#475569;font-size:13px;margin-bottom:16px}
  .meta{display:grid;grid-template-columns:repeat(4,1fr);gap:6px 18px;font-size:13px;border:1px solid #cbd5e1;border-radius:8px;padding:12px 16px;margin-bottom:18px}
  .meta b{color:#334155}
  img.iso{width:100%;border:1px solid #cbd5e1;border-radius:8px;background:#fff}
  table{width:100%;border-collapse:collapse;margin-top:18px;font-size:12.5px}
  th,td{border:1px solid #cbd5e1;padding:6px 8px;vertical-align:top}
  th{background:#f1f5f9;text-align:left} .c{text-align:center;white-space:nowrap}
  .pr-high{color:#b91c1c;font-weight:700}.pr-medium{color:#b45309;font-weight:700}
  .sign{margin-top:28px;display:flex;gap:48px;font-size:13px}
  .foot{margin-top:14px;color:#94a3b8;font-size:11px}
  @media print{ .noprint{display:none} body{margin:12mm} button{display:none} }
</style></head><body>
  <div class="noprint" style="text-align:right;margin-bottom:8px">
    <button onclick="window.print()" style="padding:8px 18px;font-size:14px;cursor:pointer">打印 / 另存为 PDF</button>
  </div>
  <h1>管道定点测厚任务单（建议加点）</h1>
  <div class="sub">编号：TS-${p.code}-${NOW.getFullYear()}${String(NOW.getMonth() + 1).padStart(2, '0')}${String(NOW.getDate()).padStart(2, '0')} · 生成日期 ${NOW.toISOString().slice(0, 10)}</div>
  <div class="meta">
    <div><b>管线号：</b>${p.code}</div>
    <div><b>装置/单元：</b>${p.unit} / ${p.block}</div>
    <div><b>介质：</b>${p.medium}</div>
    <div><b>材质：</b>${p.material}</div>
    <div><b>公称直径：</b>DN${p.dn}</div>
    <div><b>外径×壁厚等级：</b>Φ${p.outerDiameterMm} / ${p.schedule}（${p.nominalWallMm}mm）</div>
    <div><b>设计压力：</b>${p.designPressureMPa} MPa</div>
    <div><b>操作温度：</b>${p.opTempC} ℃</div>
  </div>
  <img class="iso" src="${isoPng}" alt="等轴测加点图"/>
  <table>
    <thead><tr><th>#</th><th>建议点号</th><th>管件</th><th>区域</th><th>钟点</th><th>轴向mm</th><th>基准</th><th>优先级</th><th>依据</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="9" class="c">该管线暂无新增建议点</td></tr>'}</tbody>
  </table>
  <div class="sign"><span>编制：__________</span><span>审核：__________</span><span>检测单位：__________</span><span>日期：__________</span></div>
  <div class="foot">钟点基准：观察者顺介质流向，12 点为世界正上方；弯头外弧/内弧由三维几何自动判定。位置精度优于管径的 2%。剩余寿命按 API 570 思路（长/短期速率取不利值，tMin 由设计压力与许用应力计算）。</div>
</body></html>`

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  // 新窗口便于直接打印
  const w = window.open(url, '_blank')
  if (!w) {
    // 弹窗被拦截则改为下载
    const a = document.createElement('a')
    a.href = url
    a.download = `${p.code}_测厚任务单.html`
    a.click()
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}
