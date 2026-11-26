/**
 * WebGPU 渲染引擎：管壁网格、GPU 壁厚插值、测点标记、剖切圆环、拾取、截图。
 * 无 WebGPU 环境时调用方应改用 Canvas2D 退化渲染器 (renderer-fallback.ts)。
 */
import { OrbitCamera, rayPointDist } from './camera';
import { COMPUTE_WGSL, RENDER_WGSL, MARKER_WGSL } from './shaders';
import { TubeMesh } from '../geometry/mesh';
import { FieldSample } from '../thickness/field';
import { PointPlacement } from '../types';

export type ColorMode = 'RATIO' | 'RATE_LONG' | 'RATE_SHORT' | 'DIFF' | 'PLAIN';
const MODE_INDEX: Record<ColorMode, number> = {
  RATIO: 0, RATE_LONG: 1, RATE_SHORT: 2, DIFF: 3, PLAIN: 4,
};

export interface Marker {
  position: [number, number, number];
  color: [number, number, number, number];
  size: number;
  id: string;
}

export interface EngineOptions {
  tMinByDomain: Map<string, number>;
  nominalByDomain: Map<string, number>;
  /** 真实域参数：fittingId -> { sMax, radius }，由几何内核直接给出 */
  geometryMetaByDomain?: Map<string, { sMax: number; radius: number }>;
}

export class WebGpuEngine {
  canvas: HTMLCanvasElement;
  device!: GPUDevice;
  context!: GPUCanvasContext;
  camera = new OrbitCamera();
  mesh: TubeMesh | null = null;
  private pipeline!: GPURenderPipeline;
  private renderBindLayout!: GPUBindGroupLayout;
  private markerPipeline!: GPURenderPipeline;
  private computePipeline!: GPUComputePipeline;
  private uniformBuf!: GPUBuffer;
  private paramBuf!: GPUBuffer;
  private domMetaBuf!: GPUBuffer;
  private fieldTex!: GPUTexture;
  private rateTex!: GPUTexture;
  private diffTex!: GPUTexture;
  private depthTex!: GPUTexture;
  private sampleBuf: GPUBuffer | null = null;
  private domBuf: GPUBuffer | null = null;
  private vertexBufs: Record<string, GPUBuffer> = {};
  private indexBuf: GPUBuffer | null = null;
  private indexCount = 0;
  private markerBuf: GPUBuffer | null = null;
  private markers: Marker[] = [];
  private opts: EngineOptions;
  colorMode: ColorMode = 'RATIO';
  opacity = 1;
  cutPlane: { domainIndex: number; s: number } | null = null;
  private gridRows = 0;
  private gridCols = 32;
  private domainCount = 0;
  onPick: ((id: string | null) => void) | null = null;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, opts: EngineOptions) {
    this.canvas = canvas;
    this.opts = opts;
  }

  static async isSupported(): Promise<boolean> {
    return !!navigator.gpu && (await navigator.gpu.requestAdapter()) != null;
  }

  async init() {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('未找到 WebGPU GPU 适配器');
    this.device = await adapter.requestDevice();
    this.device.addEventListener('uncapturederror', ((e: Event) => {
      const err = (e as unknown as { error?: { message?: string } }).error;
      console.error('[WebGPU]', err?.message ?? e);
    }) as EventListener);
    this.context = this.canvas.getContext('webgpu')!;
    const format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format, alphaMode: 'premultiplied' });

    // 显式布局：auto 布局会把着色器当前模式未引用的纹理绑定优化掉，
    // 导致 bindgroup 提供 6 个绑定时校验失败、整个渲染 pass 失效
    this.renderBindLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    const renderLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.renderBindLayout] });
    this.pipeline = this.device.createRenderPipeline({
      layout: renderLayout,
      vertex: {
        module: this.device.createShaderModule({ code: RENDER_WGSL }),
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
          { arrayStride: 4, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32' }] },
          { arrayStride: 4, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32' }] },
          { arrayStride: 4, attributes: [{ shaderLocation: 4, offset: 0, format: 'float32' }] },
        ],
      },
      fragment: {
        module: this.device.createShaderModule({ code: RENDER_WGSL }),
        entryPoint: 'fs',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: 'depth24plus',
      },
    });

    this.markerPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: MARKER_WGSL }),
        entryPoint: 'vs',
        buffers: [{
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x4' },
            { shaderLocation: 2, offset: 28, format: 'float32' },
          ],
        }],
      },
      fragment: {
        module: this.device.createShaderModule({ code: MARKER_WGSL }),
        entryPoint: 'fs',
        targets: [{ format }],
      },
      primitive: { topology: 'point-list' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
    });

    this.computePipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: this.device.createShaderModule({ code: COMPUTE_WGSL }), entryPoint: 'main' },
    });

    this.uniformBuf = this.device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.paramBuf = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.attachControls();
  }

  setMesh(mesh: TubeMesh, bounds: { min: number[]; max: number[] }) {
    this.mesh = mesh;
    this.domainCount = mesh.domains.length;
    this.gridRows = 40;
    this.gridCols = 32;
    const makeBuf = (data: ArrayBufferView, usage: number) => {
      const b = this.device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(b, 0, data as BufferSource);
      return b;
    };
    this.vertexBufs.position = makeBuf(mesh.positions, GPUBufferUsage.VERTEX);
    this.vertexBufs.normal = makeBuf(mesh.normals, GPUBufferUsage.VERTEX);
    this.vertexBufs.s = makeBuf(mesh.sAttr, GPUBufferUsage.VERTEX);
    this.vertexBufs.theta = makeBuf(mesh.thetaAttr, GPUBufferUsage.VERTEX);
    this.vertexBufs.domain = makeBuf(mesh.domainAttr, GPUBufferUsage.VERTEX);
    this.indexBuf = makeBuf(mesh.indices, GPUBufferUsage.INDEX);
    this.indexCount = mesh.indices.length;

    const texDesc: GPUTextureDescriptor = {
      size: { width: this.gridCols, height: this.gridRows * this.domainCount },
      format: 'r32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    };
    this.fieldTex = this.device.createTexture(texDesc);
    this.rateTex = this.device.createTexture(texDesc);
    this.diffTex = this.device.createTexture(texDesc);

    const meta = new Float32Array(this.domainCount * 4);
    mesh.domains.forEach((d, i) => {
      const dom = this.meshGeometryMeta(d.fittingId);
      meta[i * 4] = dom.sMax;
      meta[i * 4 + 1] = dom.radius;
      meta[i * 4 + 2] = this.opts.tMinByDomain.get(d.fittingId) ?? 3;
      meta[i * 4 + 3] = this.opts.nominalByDomain.get(d.fittingId) ?? 7;
    });
    this.domMetaBuf = makeBuf(meta, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.camera.frame(bounds);
  }

  private meshGeometryMeta(fittingId: string) {
    const exact = this.opts.geometryMetaByDomain?.get(fittingId);
    if (exact) return exact;
    // 兜底：由 mesh 顶点属性反推
    const m = this.mesh!;
    const di = m.domainIndex.get(fittingId)!;
    let sMax = 0;
    for (let i = 0; i < m.positions.length / 3; i++) {
      if (m.domainAttr[i] === di) sMax = Math.max(sMax, m.sAttr[i]);
    }
    return { sMax, radius: this.guessRadius(di) };
  }

  private guessRadius(di: number) {
    const m = this.mesh!;
    const off = m.domains[di].vertexOffset;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = off; i < off + 24; i++) {
      minY = Math.min(minY, m.positions[i * 3 + 1]);
      maxY = Math.max(maxY, m.positions[i * 3 + 1]);
    }
    return Math.max(10, (maxY - minY) / 2);
  }

  /** 上传一期样本并在 GPU 上跑 IDW 插值 */
  runInterpolation(samples: FieldSample[], target: 'field' | 'rate' | 'diff') {
    if (!this.mesh || samples.length === 0) return;
    const byDomain = new Map<string, FieldSample[]>();
    for (const s of samples) {
      if (!byDomain.has(s.domainId)) byDomain.set(s.domainId, []);
      byDomain.get(s.domainId)!.push(s);
    }
    interface FlatSample { x: number; y: number; z: number; w: number; v: number }
    const flat: FlatSample[] = [];
    const domInfo: { sMax: number; radius: number; count: number; offset: number }[] = [];
    // WGSL Sample{vec4f pos; f32 value; vec3f pad} 对齐后占 12 个 float(48 字节)
    const SAMPLE_STRIDE = 12;
    this.mesh.domains.forEach((d, di) => {
      const meta = this.meshGeometryMeta(d.fittingId);
      const local = byDomain.get(d.fittingId) ?? [];
      domInfo[di] = { sMax: meta.sMax, radius: meta.radius, count: local.length, offset: flat.length * SAMPLE_STRIDE };
      for (const s of local) flat.push({ x: s.s, y: s.theta, z: 0, w: 0, v: s.thickness });
    });
    const sampleData = new Float32Array(flat.length * SAMPLE_STRIDE);
    flat.forEach((s, i) => {
      // pos.xyzw, value, pad(3)
      sampleData.set([s.x, s.y, s.z, s.w, s.v, 0, 0, 0, 0, 0, 0, 0], i * SAMPLE_STRIDE);
    });
    const domData = new Float32Array(this.domainCount * 4);
    domInfo.forEach((d, i) => domData.set([d.sMax, d.radius, d.count, d.offset], i * 4));

    this.sampleBuf?.destroy();
    this.domBuf?.destroy();
    // Sample 结构含 vec4+vec3，最小绑定 48 字节；空数据也要给足尺寸否则 bindgroup 失效
    this.sampleBuf = this.device.createBuffer({ size: Math.max(48, Math.ceil(sampleData.byteLength / 16) * 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.sampleBuf, 0, sampleData);
    this.domBuf = this.device.createBuffer({ size: Math.max(16, Math.ceil(domData.byteLength / 16) * 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.domBuf, 0, domData);

    const cfg = new Float32Array([this.gridRows, this.gridCols, this.domainCount, 0, 0, 0, 0, 0]);
    // 搜索半径因子：4 倍外径，逐域在着色器内计算
    cfg[3] = 4;
    const cfgBuf = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(cfgBuf, 0, cfg);

    const tex = target === 'field' ? this.fieldTex : target === 'rate' ? this.rateTex : this.diffTex;
    const bind = this.device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: cfgBuf } },
        { binding: 1, resource: { buffer: this.sampleBuf } },
        { binding: 2, resource: { buffer: this.domBuf } },
        { binding: 3, resource: tex.createView() },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.computePipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(
      Math.ceil(this.gridCols / 8),
      Math.ceil(this.gridRows * this.domainCount / 8),
    );
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  setMarkers(markers: Marker[]) {
    this.markers = markers;
    const data = new Float32Array(markers.length * 8);
    markers.forEach((m, i) => {
      data.set([...m.position, ...m.color, m.size], i * 8);
    });
    this.markerBuf?.destroy();
    if (markers.length === 0) {
      this.markerBuf = null;
      return;
    }
    this.markerBuf = this.device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.markerBuf, 0, data);
  }

  setColorMode(mode: ColorMode) { this.colorMode = mode; }
  setOpacity(o: number) { this.opacity = o; }
  setCutPlane(c: { domainIndex: number; s: number } | null) { this.cutPlane = c; }

  private ensureDepth() {
    // 必须与画布 backing 尺寸完全一致（整数），否则深度附件尺寸不匹配会导致整个 pass 失效
    const size = { width: this.canvas.width, height: this.canvas.height };
    if (!this.depthTex || this.depthTex.width !== size.width || this.depthTex.height !== size.height) {
      this.depthTex?.destroy();
      this.depthTex = this.device.createTexture({
        size, format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
  }

  render() {
    if (!this.mesh || this.disposed) return;
    const dpr = Math.min(devicePixelRatio, 2);
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ensureDepth();
    const aspect = w / h;
    const eye = this.camera.eye();
    const camData = new Float32Array(20);
    camData.set(this.camera.viewProj(aspect), 0);
    camData.set([eye[0], eye[1], eye[2], 1], 16);
    this.device.queue.writeBuffer(this.uniformBuf, 0, camData);

    const params = new Float32Array(12);
    params[0] = MODE_INDEX[this.colorMode];
    params[1] = this.opacity;
    params[2] = 3; // tMin 基准在 domMeta 中逐域给出
    params[3] = 7;
    params[4] = this.domainCount;
    params[5] = this.gridRows;
    params[6] = this.gridCols;
    params[7] = this.cutPlane?.domainIndex ?? -1;
    params[8] = this.cutPlane?.s ?? 0;
    this.device.queue.writeBuffer(this.paramBuf, 0, params);

    const bind = this.device.createBindGroup({
      layout: this.renderBindLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: { buffer: this.paramBuf } },
        { binding: 2, resource: this.fieldTex.createView() },
        { binding: 3, resource: this.rateTex.createView() },
        { binding: 4, resource: this.diffTex.createView() },
        { binding: 5, resource: { buffer: this.domMetaBuf } },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.07, g: 0.09, b: 0.12, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTex.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    pass.setVertexBuffer(0, this.vertexBufs.position);
    pass.setVertexBuffer(1, this.vertexBufs.normal);
    pass.setVertexBuffer(2, this.vertexBufs.s);
    pass.setVertexBuffer(3, this.vertexBufs.theta);
    pass.setVertexBuffer(4, this.vertexBufs.domain);
    pass.setIndexBuffer(this.indexBuf!, 'uint32');
    pass.drawIndexed(this.indexCount);

    if (this.markerBuf) {
      const mBind = this.device.createBindGroup({
        layout: this.markerPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.uniformBuf } }],
      });
      pass.setPipeline(this.markerPipeline);
      pass.setBindGroup(0, mBind);
      pass.setVertexBuffer(0, this.markerBuf);
      pass.draw(this.markers.length);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /** 屏幕坐标拾取测点，返回 marker id */
  pick(clientX: number, clientY: number, placements: PointPlacement[]): string | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
    const { origin, dir } = this.camera.ray(ndcX, ndcY, rect.width / rect.height);
    let best: string | null = null;
    let bestD = Infinity;
    const pickRadius = this.camera.distance * 0.004;
    for (const p of placements) {
      const d = rayPointDist(origin, dir, p.position);
      if (d < pickRadius && d < bestD) {
        bestD = d;
        best = p.pointId;
      }
    }
    return best;
  }

  async screenshot(): Promise<Blob> {
    await this.device.queue.onSubmittedWorkDone();
    const blob = await new Promise<Blob>((resolve, reject) =>
      this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('截图失败'))), 'image/png'));
    return blob;
  }

  private attachControls() {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const down = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    };
    const up = (e: PointerEvent) => {
      const moved = Math.hypot(e.clientX - lastX, e.clientY - lastY);
      dragging = false;
      if (moved < 4 && this.onPick) this.onPick(this.tryPick(e.clientX, e.clientY));
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.camera.yaw -= dx * 0.008;
      this.camera.pitch = Math.max(-1.45, Math.min(1.45, this.camera.pitch + dy * 0.008));
      this.render();
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.camera.distance = Math.max(200, this.camera.distance * (1 + Math.sign(e.deltaY) * 0.12));
      this.render();
    };
    this.canvas.addEventListener('pointerdown', down);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('wheel', wheel, { passive: false });
  }

  private pickPlacement: PointPlacement[] = [];
  setPickable(placements: PointPlacement[]) {
    this.pickPlacement = placements;
  }
  private tryPick(x: number, y: number) {
    return this.pick(x, y, this.pickPlacement);
  }

  dispose() {
    this.disposed = true;
    Object.values(this.vertexBufs).forEach((b) => b.destroy());
    this.indexBuf?.destroy();
    this.markerBuf?.destroy();
    this.sampleBuf?.destroy();
    this.domBuf?.destroy();
    this.fieldTex?.destroy();
    this.rateTex?.destroy();
    this.diffTex?.destroy();
    this.depthTex?.destroy();
  }
}
