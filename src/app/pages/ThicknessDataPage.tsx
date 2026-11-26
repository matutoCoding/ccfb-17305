import { useRef, useState } from 'preact/hooks';
import { getState, recompute, reloadPipelines } from '../../state/store';
import { repo, uid } from '../../db';
import { parseCScanCsv, parseThicknessCsv } from '../../thickness/csv-import';
import { Card, Pill, fmtDate } from '../components';
import { BadRow } from '../../types';

const REASON_NAME: Record<BadRow['reason'], string> = {
  POINT_NOT_FOUND: '点号找不到',
  THICKNESS_EXCEEDS_NOMINAL: '读数大于名义壁厚',
  BAD_UNIT_INCH: '疑似单位填成英寸',
  PARSE_ERROR: '解析失败',
};

export function ThicknessDataPage() {
  const s = getState();
  const fileRef = useRef<HTMLInputElement>(null);
  const cscanRef = useRef<HTMLInputElement>(null);
  const [roundId, setRoundId] = useState(s.rounds[s.rounds.length - 1]?.id ?? '');
  const [tip, setTip] = useState('');

  const nominalByPoint = new Map(s.bundle!.points.map((p) => [
    p.id, s.bundle!.fittings.find((f) => f.id === p.fittingId)?.nominalWall ?? s.bundle!.pipeline.nominalWall,
  ]));

  const onCsv = async (file: File) => {
    if (!roundId) { setTip('请先选择或新建期次'); return; }
    const text = await file.text();
    const parsed = parseThicknessCsv(text, s.bundle!.points, nominalByPoint);
    await repo.addReadings(parsed.readings.map((r) => ({ ...r, id: uid('rd'), roundId })));
    await repo.addBadRows(parsed.badRows.map((b) => ({ ...b, id: uid('bad'), roundId })));
    await reloadPipelines();
    await recompute();
    setTip(`导入 ${parsed.readings.length} 条，坏行 ${parsed.badRows.length} 条已单列`);
  };

  const onCScan = async (file: File) => {
    if (!roundId) return;
    const text = await file.text();
    const parsed = parseCScanCsv(text);
    const fitting = s.bundle!.fittings.find((f) => f.tag === parsed.grid.pointNoBase || f.tag.startsWith(parsed.grid.pointNoBase));
    if (!fitting) { setTip(`C 扫描基准点号 ${parsed.grid.pointNoBase} 找不到对应弯头`); return; }
    await repo.putCScan({ id: uid('cs'), roundId, fittingId: fitting.id, ...parsed.grid });
    await reloadPipelines();
    await recompute();
    setTip(`C 扫描网格 ${parsed.grid.rows}×${parsed.grid.cols} 已贴到弯头 ${fitting.tag}`);
  };

  const addRound = async () => {
    const name = prompt('期次名称，如 2026-大修');
    if (!name) return;
    const r = { id: uid('rnd'), name, inspectDate: Date.now() };
    await repo.putRound(r);
    await reloadPipelines();
    setRoundId(r.id);
  };

  const badRows = s.badRows.filter((b) => b.roundId === roundId);
  const round = s.rounds.find((r) => r.id === roundId);

  return (
    <div className="content scroll">
      <div className="split">
        <div>
          <Card title="测厚期次与 CSV 导入">
            <div className="row" style={{ marginBottom: 10 }}>
              <select value={roundId} onChange={(e) => setRoundId((e.target as HTMLSelectElement).value)}>
                {s.rounds.map((r) => <option value={r.id}>{r.name}（{fmtDate(r.inspectDate)}）</option>)}
              </select>
              <button className="ghost" onClick={addRound}>+ 新建期次</button>
            </div>
            <div className="row">
              <input ref={fileRef} type="file" accept=".csv,.txt" style={{ display: 'none' }}
                onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) onCsv(f); }} />
              <button className="primary" onClick={() => fileRef.current?.click()}>导入测厚 CSV（一期一文件）</button>
              <input ref={cscanRef} type="file" accept=".csv" style={{ display: 'none' }}
                onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) onCScan(f); }} />
              <button onClick={() => cscanRef.current?.click()}>导入弯头外弧 C 扫描网格</button>
            </div>
            {tip && <div className="warn-text" style={{ marginTop: 8 }}>{tip}</div>}
            <div className="muted" style={{ marginTop: 10, lineHeight: 1.8 }}>
              CSV 表头：<span className="mono">点号,厚度(mm)</span>；坏行不进读数库，按原因单列。<br />
              C 扫描文件以 <span className="mono">#pointNoBase=#axialStart=…</span> 元信息开头，网格自动贴回弯头曲面 (s, 钟点) 位置。
            </div>
          </Card>

          <Card title={`坏行清单（${badRows.length}）`}>
            {badRows.length === 0 ? <div className="ok-text">本期无坏行</div> : (
              <table>
                <thead><tr><th>行号</th><th>原因</th><th>原始内容</th><th>说明</th></tr></thead>
                <tbody>
                  {badRows.map((b) => (
                    <tr key={b.id} className="bad-row">
                      <td>{b.rowIndex}</td>
                      <td><Pill kind="danger">{REASON_NAME[b.reason]}</Pill></td>
                      <td className="mono">{b.raw}</td>
                      <td>{b.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div>
          <Card title={`期次读数概览 — ${round?.name ?? ''}`}>
            <table>
              <thead><tr><th>期次</th><th>日期</th><th>读数条数</th><th>C 扫描</th></tr></thead>
              <tbody>
                {s.rounds.map((r) => (
                  <tr key={r.id} style={r.id === roundId ? { background: 'var(--panel2)' } : undefined}>
                    <td>{r.name}</td>
                    <td>{fmtDate(r.inspectDate)}</td>
                    <td>{s.cscans.length >= 0 ? countReadings(s, r.id) : 0}</td>
                    <td>{s.cscans.filter((c) => c.roundId === r.id).length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="可疑增厚点（两期对比自动标记）">
            {!s.diff ? <div className="muted">至少两期数据后自动计算</div> : (
              <>
                <div className="row" style={{ marginBottom: 8 }}>
                  <Pill kind="warn">可疑点 {s.diff.suspiciousCount}</Pill>
                  <span className="muted">后一期比前一期厚出测量误差(0.1mm)，不参与速率计算</span>
                </div>
                <table>
                  <thead><tr><th>点号</th><th>前期</th><th>后期</th><th>差值</th></tr></thead>
                  <tbody>
                    {s.diff.pointDiffs.filter((d) => d.suspicious).map((d) => (
                      <tr key={d.pointNo ?? Math.random()}>
                        <td className="mono">{d.pointNo ?? '—'}</td>
                        <td>{d.prevThickness.toFixed(3)}</td>
                        <td>{d.nextThickness.toFixed(3)}</td>
                        <td className="warn-text mono">+{d.delta.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function countReadings(s: ReturnType<typeof getState>, roundId: string): number {
  // readings 全量在 IndexedDB，这里用壁厚场样本数近似展示（C 扫描另计）
  return s.fields.get(roundId)?.samples.filter((x) => !(x.pointNo ?? '').includes('-C')).length ?? 0;
}
