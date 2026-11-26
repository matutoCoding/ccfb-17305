/**
 * Canvas2D 退化渲染器：浏览器不支持 WebGPU 时使用。
 * 中心线投影 + 管径圆描边 + 测点标记，支持同样的相机交互与拾取；
 * 云图颜色仍由 CPU 壁厚场 lookupGrid 逐点给出，数据口径不变。
 */
import { OrbitCamera, rayPointDist } from './camera';
import { TubeMesh } from '../geometry/mesh';
import { PointPlacement } from '../types';
import { lookupGrid, ThicknessField } from '../thickness/field';

export interface FallbackMarker {
  position: [number, number, number];
  color: string;
  id: string;
}

export class FallbackRenderer {
  canvas: HTMLCanvasElement;
  camera = new OrbitCamera();
  mesh: TubeMesh | null = null;
  field: ThicknessField | null = null;
  tMinByDomain = new Map<string, number>();
  markers: FallbackMarker[] = [];
  onPick: ((id: string | null) => void) | null = null;
  private placements: PointPlacement[] = [];
  private raf = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  setMesh(mesh: TubeMesh, bounds: { min: number[]; max: number[] }) {
    this.mesh = mesh;
    this.camera.frame(bounds);
  }
  setField(f: ThicknessField) { this.field = f; }
  setMarkers(m: FallbackMarker[]) { this.markers = m; }
  setPickable(p: PointPlacement[]) { this.placements = p; }

  private project(p: number[], aspect: number) {
    const m = this.camera.viewProj(aspect);
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    const nx = x / w;
    const ny = y / w;
    return {
      x: (nx * 0.5 + 0.5) * this.canvas.width,
      y: (1 - (ny * 0.5 + 0.5)) * this.canvas.height,
      depth: w,
    };
  }

  private ratioColor(ratio: number): string {
    const stops: [number, [number, number, number]][] = [
      [0.4, [212, 31, 31]], [0.7, [242, 115, 26]], [0.9, [242, 204, 38]],
      [1.1, [89, 191, 76]], [1.4, [51, 140, 217]],
    ];
    let c: [number, number, number] = stops[stops.length - 1][1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (ratio <= stops[i + 1][0]) {
        const [r0, c0] = stops[i];
        const [r1, c1] = stops[i + 1];
        const f = Math.max(0, (ratio - r0) / (r1 - r0));
        c = [
          Math.round(c0[0] + (c1[0] - c0[0]) * f),
          Math.round(c0[1] + (c1[1] - c0[1]) * f),
          Math.round(c0[2] + (c1[2] - c0[2]) * f),
        ];
        break;
      }
    }
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  render() {
    if (!this.mesh) return;
    const dpr = Math.min(devicePixelRatio, 2);
    const w = Math.max(2, this.canvas.clientWidth * dpr);
    const h = Math.max(2, this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    const ctx = this.canvas.getContext('2d')!;
    const aspect = w / h;
    ctx.fillStyle = '#12171f';
    ctx.fillRect(0, 0, w, h);

    const m = this.mesh;
    // 按域中心深度从远到近画
    const drawList = m.domains.map((d) => {
      const off = d.vertexOffset;
      const c = Array.from(m.positions.slice(off * 3, off * 3 + 3));
      return { d, depth: this.project(c, aspect).depth };
    }).sort((a, b) => b.depth - a.depth);

    for (const { d } of drawList) {
      const grid = this.field?.grids.get(d.fittingId);
      const tMin = this.tMinByDomain.get(d.fittingId) ?? 3;
      const segs = d.indexCount / 6;
      for (let i = 0; i < segs; i++) {
        const ia = m.indices[d.indexOffset + i * 6];
        const ib = m.indices[d.indexOffset + i * 6 + 1];
        const pa = this.project([m.positions[ia * 3], m.positions[ia * 3 + 1], m.positions[ia * 3 + 2]], aspect);
        const pb = this.project([m.positions[ib * 3], m.positions[ib * 3 + 1], m.positions[ib * 3 + 2]], aspect);
        let color = 'rgb(158,158,168)';
        if (grid) {
          const t = lookupGrid(grid, m.sAttr[ia], m.thetaAttr[ia]);
          if (Number.isFinite(t)) color = this.ratioColor(t / tMin);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, dpr * 1.5);
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }
    }

    for (const mk of this.markers) {
      const p = this.project(mk.position, aspect);
      ctx.fillStyle = mk.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  start() {
    const loop = () => {
      this.render();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { cancelAnimationFrame(this.raf); }

  attachControls() {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - lastX, e.clientY - lastY) < 4) {
        const rect = this.canvas.getBoundingClientRect();
        const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
        const { origin, dir } = this.camera.ray(ndcX, ndcY, rect.width / rect.height);
        let best: string | null = null;
        let bestD = Infinity;
        const pr = this.camera.distance * 0.004;
        for (const p of this.placements) {
          const dd = rayPointDist(origin, dir, p.position);
          if (dd < pr && dd < bestD) { bestD = dd; best = p.pointId; }
        }
        this.onPick?.(best);
      }
      dragging = false;
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.camera.yaw -= dx * 0.008;
      this.camera.pitch = Math.max(-1.45, Math.min(1.45, this.camera.pitch + dy * 0.008));
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camera.distance = Math.max(200, this.camera.distance * (1 + Math.sign(e.deltaY) * 0.12));
    }, { passive: false });
  }
}
