/** 通用小组件 */
import { JSX } from 'preact';
import type * as preact from 'preact';

export function Pill(props: { kind?: 'danger' | 'warn' | 'ok'; children: preact.ComponentChildren }) {
  const cls = props.kind ? `tag-pill tag-${props.kind}` : 'tag-pill';
  return <span className={cls}>{props.children}</span>;
}

export function fmtDate(ts: number | null | undefined): string {
  if (ts == null) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmt(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

export function Card(props: { title?: string; children: preact.ComponentChildren; extra?: JSX.Element }) {
  return (
    <div className="card">
      {props.title && <h3>{props.title}{props.extra && <span style={{ float: 'right' }}>{props.extra}</span>}</h3>}
      {props.children}
    </div>
  );
}
