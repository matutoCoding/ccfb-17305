/* WebGPU 三维渲染器：
 * - 计算着色器对每个管壁顶点做"同管件 + 表面距离"IDW 插值
 * - 渲染壁厚/速率/差值云图、五金、测点球、剖面圆环
 * 所有 GPU 对象按 any 处理，避免依赖 @webgpu/types 版本。
 */
import type { Vec3 } from '../domain/types'
import { OrbitCamera } from './camera'

export interface GpuMarker {
  pos: Vec3
  color: [number, number, number]
  size: number
  id?: string
}

export interface GpuSample {
  fit: number
  s: number
  psi: number
  radius: number
  value: number
}

const TUBE_WGSL = /* wgsl */ `
struct U {
  vp: mat4x4<f32>,
  clipPlane: vec4<f32>,
  opacity: f32, clipOn: f32, mode: f32, maxRate: f32, tMin: f32,
  pad0: f32, pad1: f32, pad2: f32,
};
@group(0) @binding(0) var<uniform> u: U;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wp: vec3<f32>,
  @location(1) n: vec3<f32>,
  @location(2) val: f32,
};

@vertex
fn vs(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>, @location(2) val: f32) -> VOut {
  var o: VOut;
  o.pos = u.vp * vec4<f32>(p, 1.0);
  o.wp = p; o.n = n; o.val = val;
  return o;
}

fn lerp3(a: vec3<f32>, b: vec3<f32>, t: f32) -> vec3<f32> { return a + (b - a) * t; }

fn ratioColor(r: f32) -> vec3<f32> {
  let c0 = vec3<f32>(0.75,0.11,0.16);
  let c1 = vec3<f32>(0.93,0.35,0.14);
  let c2 = vec3<f32>(0.95,0.61,0.07);
  let c3 = vec3<f32>(0.95,0.85,0.25);
  let c4 = vec3<f32>(0.20,0.69,0.42);
  if (r < 1.0) { return c0; }
  if (r < 1.2) { return mix(c0,c1,(r-1.0)/0.2); }
  if (r < 1.5) { return mix(c1,c2,(r-1.2)/0.3); }
  if (r < 2.0) { return mix(c2,c3,(r-1.5)/0.5); }
  return mix(c3,c4, clamp((r-2.0)/1.0,0.0,1.0));
}
fn rateColor(x: f32) -> vec3<f32> {
  let t = clamp(x / u.maxRate, 0.0, 1.0);
  let g = vec3<f32>(0.20,0.69,0.42);
  let y = vec3<f32>(0.95,0.85,0.25);
  let r = vec3<f32>(0.85,0.15,0.18);
  if (t < 0.5) { return mix(g,y,t/0.5); }
  return mix(y,r,(t-0.5)/0.5);
}
fn diffColor(x: f32) -> vec3<f32> {
  let t = clamp(x / 1.5, -1.0, 1.0);
  if (t < 0.0) { return mix(vec3<f32>(0.92,0.92,0.95), vec3<f32>(0.75,0.15,0.18), -t); }
  return mix(vec3<f32>(0.92,0.92,0.95), vec3<f32>(0.15,0.40,0.75), t);
}

@fragment
fn fs(i: VOut) -> @location(0) vec4<f32> {
  if (u.clipOn > 0.5) {
    let d = dot(i.wp, u.clipPlane.xyz) + u.clipPlane.w;
    if (d > 0.0) { discard; }
  }
  var base = vec3<f32>(0.62,0.65,0.70);
  if (i.val < -0.5) {
    base = vec3<f32>(0.55,0.58,0.64); // 无数据
  } else if (u.mode < 0.5) {
    base = ratioColor(i.val / max(u.tMin, 0.001));
  } else if (u.mode < 1.5) {
    base = rateColor(i.val);
  } else {
    base = diffColor(i.val);
  }
  let L = normalize(vec3<f32>(0.45,0.85,0.55));
  let d = max(dot(normalize(i.n), L), 0.0);
  let shade = 0.62 + 0.5 * d;
  // 简单边缘光
  return vec4<f32>(base * shade, u.opacity);
}
`

const COLOR_WGSL = /* wgsl */ `
struct U { vp: mat4x4<f32>, pad: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct VO { @builtin(position) pos: vec4<f32>, @location(0) n: vec3<f32>, @location(1) c: vec3<f32> };
@vertex
fn vs(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>, @location(2) c: vec3<f32>) -> VO {
  var o: VO; o.pos = u.vp * vec4<f32>(p,1.0); o.n=n; o.c=c; return o;
}
@fragment
fn fs(i: VO) -> @location(0) vec4<f32> {
  let L = normalize(vec3<f32>(0.45,0.85,0.55));
  let d = max(dot(normalize(i.n),L),0.0);
  return vec4<f32>(i.c*(0.6+0.55*d), 1.0);
}
`

const MARKER_WGSL = /* wgsl */ `
struct U { vp: mat4x4<f32>, pad: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct Inst { @location(3) ip: vec4<f32>, @location(4) ic: vec4<f32> };
struct VO { @builtin(position) pos: vec4<f32>, @location(0) n: vec3<f32>, @location(1) c: vec3<f32> };
@vertex
fn vs(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>, inst: Inst) -> VO {
  var o: VO;
  let w = p * inst.ip.w + inst.ip.xyz;
  o.pos = u.vp * vec4<f32>(w,1.0);
  o.n = n; o.c = inst.ic.xyz; return o;
}
@fragment
fn fs(i: VO) -> @location(0) vec4<f32> {
  let L = normalize(vec3<f32>(0.4,0.9,0.5));
  let d = max(dot(normalize(i.n),L),0.0);
  let rim = pow(1.0-abs(dot(normalize(i.n), vec3<f32>(0.0,0.0,1.0))),2.0)*0.25;
  return vec4<f32>(i.c*(0.55+0.6*d)+rim, 1.0);
}
`

const RING_WGSL = /* wgsl */ `
struct U { vp: mat4x4<f32>, pad: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct VO { @builtin(position) pos: vec4<f32>, @location(0) c: vec3<f32> };
@vertex
fn vs(@location(0) p: vec3<f32>, @location(1) c: vec3<f32>) -> VO {
  var o:VO; o.pos=u.vp*vec4<f32>(p,1.0); o.c=c; return o;
}
@fragment
fn fs(i:VO)->@location(0) vec4<f32> { return vec4<f32>(i.c, 0.96); }
`

const COMPUTE_WGSL = /* wgsl */ `
struct Sample { d0: vec4<f32>, d1: vec4<f32> };
struct CMConfig { sampleCount: u32, vertexCount: u32, power: f32, cpad: f32 };
@group(0) @binding(0) var<storage, read> samples: array<Sample>;
@group(0) @binding(1) var<storage, read_write> outVals: array<f32>;
@group(0) @binding(2) var<uniform> cm: CMConfig;
@group(0) @binding(3) var<storage, read> vmeta: array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= cm.vertexCount) { return; }
  let m = vmeta[i];
  let fit = m.x; let s = m.y; let psi = m.z; let rad = m.w;
  var wsum = 0.0; var vsum = 0.0; var exact = 0.0; var hasExact = false;
  for (var k = 0u; k < cm.sampleCount; k = k + 1u) {
    let sm = samples[k];
    if (abs(sm.d0.x - fit) > 0.5) { continue; }
    let ds = s - sm.d0.y;
    var dp = abs(psi - sm.d0.z);
    dp = min(dp, 6.28318530718 - dp);
    let r = 0.5 * (rad + sm.d0.w);
    let d = sqrt(ds*ds + (r*dp)*(r*dp));
    if (d < 1.0e-4) { exact = sm.d1.x; hasExact = true; }
    else { let w = pow(r / max(d, 1.0e-3), cm.power); wsum += w; vsum += w * sm.d1.x; }
  }
  if (hasExact) { outVals[i] = exact; }
  else if (wsum > 0.0) { outVals[i] = vsum / wsum; }
  else { outVals[i] = -1.0; }
}
`

export interface RenderOptions {
  mode: 0 | 1 | 2
  opacity: number
  tMin: number
  maxRate?: number
  clip?: { point: Vec3; tangent: Vec3 } | null
}

export class GpuLineRenderer {
  canvas: HTMLCanvasElement
  camera = new OrbitCamera()
  private gpu: any
  private device: any
  private context: any
  private format: any
  private depthTex: any
  private uniform: any
  private uniformData = new Float32Array(32)
  private tubePipe: any
  private tubePipeBlend: any
  private colorPipe: any
  private markerPipe: any
  private ringPipe: any
  private computePipe: any
  private vmetaBuf: any
  private scalarBuf: any
  private posBuf: any
  private nrmBuf: any
  private idxBuf: any
  private indexCount = 0
  private vertexCount = 0
  private hardware: { pos: any; nrm: any; col: any; idx: any; count: number } | null = null
  private sphere: { pos: any; nrm: any; idx: any; count: number } | null = null
  private markerBuf: any
  private markerCount = 0
  markerData: GpuMarker[] = []
  private sampleBuf: any
  private sampleCount = 0
  private cmBuf: any
  private ring: { posBuf: any; colBuf: any; idxBuf: any; count: number } | null = null
  private opts: RenderOptions = { mode: 0, opacity: 1, tMin: 3 }
  private raf = 0
  private disposed = false
  private inited = false
  onContextLost?: () => void

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.gpu = (navigator as any).gpu
  }

  static supported(): boolean {
    return !!(navigator as any).gpu
  }

  async init(): Promise<boolean> {
    if (!this.gpu) return false
    try {
      const adapter = await this.gpu.requestAdapter({ powerPreference: 'high-performance' })
      if (!adapter) return false
      this.device = await adapter.requestDevice()
      this.device.addEventListener?.('uncapturederror', (e: any) => {
        console.error('WebGPU 校验错误:', e?.error?.message || e?.message || e)
      })
      this.device.lost?.then(() => this.onContextLost?.())
      this.context = this.canvas.getContext('webgpu')
      if (!this.context) return false
      this.format = this.gpu.getPreferredCanvasFormat ? this.gpu.getPreferredCanvasFormat() : 'bgra8unorm'
      this.resize()
      this.context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' })

      this.uniform = this.device.createBuffer({ size: 128, usage: 0x40 | 0x08 }) // UNIFORM|COPY_DST
      this.cmBuf = this.device.createBuffer({ size: 16, usage: 0x40 | 0x08 })

      const mod = (code: string) => this.device.createShaderModule({ code })
      const depth = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' }

      this.tubePipe = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: mod(TUBE_WGSL),
          entryPoint: 'vs',
          buffers: [
            { arrayStride: 12, attributes: [{ shaderLocation: 0, format: 'float32x3', offset: 0 }] },
            { arrayStride: 12, attributes: [{ shaderLocation: 1, format: 'float32x3', offset: 0 }] },
            { arrayStride: 4, attributes: [{ shaderLocation: 2, format: 'float32', offset: 0 }] }
          ]
        },
        fragment: {
          module: mod(TUBE_WGSL),
          entryPoint: 'fs',
          targets: [{ format: this.format }]
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depth
      })
      this.tubePipeBlend = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: mod(TUBE_WGSL),
          entryPoint: 'vs',
          buffers: [
            { arrayStride: 12, attributes: [{ shaderLocation: 0, format: 'float32x3', offset: 0 }] },
            { arrayStride: 12, attributes: [{ shaderLocation: 1, format: 'float32x3', offset: 0 }] },
            { arrayStride: 4, attributes: [{ shaderLocation: 2, format: 'float32', offset: 0 }] }
          ]
        },
        fragment: {
          module: mod(TUBE_WGSL),
          entryPoint: 'fs',
          targets: [
            {
              format: this.format,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
              }
            }
          ]
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' }
      })

      const colorBuffers = [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, format: 'float32x3', offset: 0 }] },
        { arrayStride: 12, attributes: [{ shaderLocation: 1, format: 'float32x3', offset: 0 }] },
        { arrayStride: 12, attributes: [{ shaderLocation: 2, format: 'float32x3', offset: 0 }] }
      ]
      this.colorPipe = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: mod(COLOR_WGSL), entryPoint: 'vs', buffers: colorBuffers },
        fragment: { module: mod(COLOR_WGSL), entryPoint: 'fs', targets: [{ format: this.format }] },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: depth
      })

      this.markerPipe = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: mod(MARKER_WGSL),
          entryPoint: 'vs',
          buffers: [
            { arrayStride: 12, attributes: [{ shaderLocation: 0, format: 'float32x3', offset: 0 }] },
            { arrayStride: 12, attributes: [{ shaderLocation: 1, format: 'float32x3', offset: 0 }] },
            {
              arrayStride: 32,
              stepMode: 'instance',
              attributes: [
                { shaderLocation: 3, format: 'float32x4', offset: 0 },
                { shaderLocation: 4, format: 'float32x4', offset: 16 }
              ]
            }
          ]
        },
        fragment: { module: mod(MARKER_WGSL), entryPoint: 'fs', targets: [{ format: this.format }] },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: depth
      })

      this.ringPipe = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: mod(RING_WGSL),
          entryPoint: 'vs',
          buffers: [
            { arrayStride: 12, attributes: [{ shaderLocation: 0, format: 'float32x3', offset: 0 }] },
            { arrayStride: 12, attributes: [{ shaderLocation: 1, format: 'float32x3', offset: 0 }] }
          ]
        },
        fragment: {
          module: mod(RING_WGSL),
          entryPoint: 'fs',
          targets: [
            {
              format: this.format,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
              }
            }
          ]
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depth
      })

      const computeModule = this.device.createShaderModule({ code: COMPUTE_WGSL })
      this.computePipe = this.device.createComputePipeline({
        layout: 'auto',
        compute: { module: computeModule, entryPoint: 'main' }
      })

      this.inited = true
      const loop = () => {
        if (this.disposed) return
        this.render()
        this.raf = requestAnimationFrame(loop)
      }
      this.raf = requestAnimationFrame(loop)
      return true
    } catch (e) {
      console.error('WebGPU 初始化失败', e)
      return false
    }
  }

  resize() {
    if (!this.device || !this.canvas) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr))
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    this.camera.aspect = w / h
    this.depthTex?.destroy?.()
    this.depthTex = this.device.createTexture({
      size: [w, h],
      format: 'depth24plus',
      usage: 0x10 // RENDER_ATTACHMENT
    })
  }

  private buf(data: Float32Array | Uint32Array, usage: number) {
    const b = this.device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true })
    new (data.constructor as any)(b.getMappedRange()).set(data)
    b.unmap()
    return b
  }

  setCloudMesh(mesh: { positions: Float32Array; normals: Float32Array; metas: Float32Array; indices: Uint32Array }) {
    if (!this.inited) return
    this.vertexCount = mesh.positions.length / 3
    this.indexCount = mesh.indices.length
    this.posBuf = this.buf(mesh.positions, 0x20)
    this.nrmBuf = this.buf(mesh.normals, 0x20)
    this.idxBuf = this.buf(mesh.indices, 0x10)
    this.vmetaBuf = this.buf(mesh.metas, 0x80) // STORAGE
    this.scalarBuf?.destroy?.()
    this.scalarBuf = this.device.createBuffer({
      size: this.vertexCount * 4,
      usage: 0x80 | 0x20 // STORAGE | VERTEX
    })
    this.dispatchCompute()
  }

  setHardware(m: { positions: Float32Array; normals: Float32Array; colors: Float32Array; indices: Uint32Array }) {
    if (!this.inited) return
    this.hardware = {
      pos: this.buf(m.positions, 0x20),
      nrm: this.buf(m.normals, 0x20),
      col: this.buf(m.colors, 0x20),
      idx: this.buf(m.indices, 0x10),
      count: m.indices.length
    }
  }

  setSphere(s: { positions: Float32Array; normals: Float32Array; indices: Uint32Array }) {
    if (!this.inited) return
    this.sphere = {
      pos: this.buf(s.positions, 0x20),
      nrm: this.buf(s.normals, 0x20),
      idx: this.buf(s.indices, 0x10),
      count: s.indices.length
    }
  }

  setMarkers(markers: GpuMarker[]) {
    if (!this.inited) return
    this.markerCount = markers.length
    this.markerData = markers
    if (!markers.length) {
      this.markerBuf = null
      return
    }
    const data = new Float32Array(markers.length * 8)
    markers.forEach((m, i) => {
      data[i * 8 + 0] = m.pos[0]
      data[i * 8 + 1] = m.pos[1]
      data[i * 8 + 2] = m.pos[2]
      data[i * 8 + 3] = m.size
      data[i * 8 + 4] = m.color[0]
      data[i * 8 + 5] = m.color[1]
      data[i * 8 + 6] = m.color[2]
      data[i * 8 + 7] = 1
    })
    this.markerBuf?.destroy?.()
    this.markerBuf = this.buf(data, 0x20)
  }

  setSamples(samples: GpuSample[]) {
    if (!this.inited) return
    this.sampleCount = samples.length
    const data = new Float32Array(Math.max(1, samples.length) * 8)
    samples.forEach((s, i) => {
      data[i * 8 + 0] = s.fit
      data[i * 8 + 1] = s.s
      data[i * 8 + 2] = s.psi
      data[i * 8 + 3] = s.radius
      data[i * 8 + 4] = s.value
    })
    this.sampleBuf?.destroy?.()
    this.sampleBuf = this.buf(data, 0x80)
    this.dispatchCompute()
  }

  setRing(ring: { positions: Float32Array; colors: Float32Array; indices: Uint32Array } | null) {
    if (!this.inited) return
    if (!ring) {
      this.ring = null
      return
    }
    this.ring = {
      posBuf: this.buf(ring.positions, 0x20),
      colBuf: this.buf(ring.colors, 0x20),
      idxBuf: this.buf(ring.indices, 0x10),
      count: ring.indices.length
    }
  }

  setOptions(o: Partial<RenderOptions>) {
    this.opts = { ...this.opts, ...o }
  }

  private dispatchCompute() {
    if (!this.inited || !this.computePipe || !this.scalarBuf || !this.vmetaBuf) return
    const count = Math.max(1, this.sampleCount)
    const cm = new ArrayBuffer(16)
    new Uint32Array(cm, 0, 2).set([count, this.vertexCount])
    new Float32Array(cm, 8, 1)[0] = 4 // power
    this.device.queue.writeBuffer(this.cmBuf, 0, cm)
    const bg = this.device.createBindGroup({
      layout: this.computePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.sampleBuf ?? this.device.createBuffer({ size: 32, usage: 0x80 }) } },
        { binding: 1, resource: { buffer: this.scalarBuf } },
        { binding: 2, resource: { buffer: this.cmBuf } },
        { binding: 3, resource: { buffer: this.vmetaBuf } }
      ]
    })
    const enc = this.device.createCommandEncoder()
    const pass = enc.beginComputePass()
    pass.setPipeline(this.computePipe)
    pass.setBindGroup(0, bg)
    pass.dispatchWorkgroups(Math.ceil(this.vertexCount / 64))
    pass.end()
    this.device.queue.submit([enc.finish()])
  }

  private updateUniform() {
    const cam = this.camera.viewProj()
    this.uniformData.set(cam, 0)
    // clip plane
    if (this.opts.clip) {
      const t = this.opts.clip.tangent
      const p = this.opts.clip.point
      this.uniformData[16] = t[0]
      this.uniformData[17] = t[1]
      this.uniformData[18] = t[2]
      this.uniformData[19] = -(t[0] * p[0] + t[1] * p[1] + t[2] * p[2])
      this.uniformData[21] = 1
    } else {
      this.uniformData[21] = 0
    }
    this.uniformData[20] = this.opts.opacity
    this.uniformData[22] = this.opts.mode
    this.uniformData[23] = this.opts.maxRate ?? 1.2
    this.uniformData[24] = this.opts.tMin
    this.device.queue.writeBuffer(this.uniform, 0, this.uniformData)
  }

  private render() {
    if (!this.inited || this.disposed) return
    this.resize()
    this.updateUniform()
    const tex = this.context.getCurrentTexture()
    const view = tex.createView()
    const depthView = this.depthTex.createView()
    const enc = this.device.createCommandEncoder()
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0.045, g: 0.06, b: 0.095, a: 1 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store'
      }
    })

    // 管壁云图
    if (this.indexCount && this.posBuf) {
      const opaque = this.opts.opacity >= 0.999
      pass.setPipeline(opaque ? this.tubePipe : this.tubePipeBlend)
      const bg = this.device.createBindGroup({
        layout: (opaque ? this.tubePipe : this.tubePipeBlend).getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.uniform } }]
      })
      pass.setBindGroup(0, bg)
      pass.setVertexBuffer(0, this.posBuf)
      pass.setVertexBuffer(1, this.nrmBuf)
      pass.setVertexBuffer(2, this.scalarBuf)
      pass.setIndexBuffer(this.idxBuf, 'uint32')
      pass.drawIndexed(this.indexCount)
    }

    // 五金
    if (this.hardware) {
      pass.setPipeline(this.colorPipe)
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: this.colorPipe.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: this.uniform } }]
        })
      )
      pass.setVertexBuffer(0, this.hardware.pos)
      pass.setVertexBuffer(1, this.hardware.nrm)
      pass.setVertexBuffer(2, this.hardware.col)
      pass.setIndexBuffer(this.hardware.idx, 'uint32')
      pass.drawIndexed(this.hardware.count)
    }

    // 测点
    if (this.sphere && this.markerCount && this.markerBuf) {
      pass.setPipeline(this.markerPipe)
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: this.markerPipe.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: this.uniform } }]
        })
      )
      pass.setVertexBuffer(0, this.sphere.pos)
      pass.setVertexBuffer(1, this.sphere.nrm)
      pass.setVertexBuffer(2, this.markerBuf)
      pass.setIndexBuffer(this.sphere.idx, 'uint32')
      pass.drawIndexed(this.sphere.count, this.markerCount)
    }

    // 剖面圆环
    if (this.ring) {
      pass.setPipeline(this.ringPipe)
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: this.ringPipe.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: this.uniform } }]
        })
      )
      pass.setVertexBuffer(0, this.ring.posBuf)
      pass.setVertexBuffer(1, this.ring.colBuf)
      pass.setIndexBuffer(this.ring.idxBuf, 'uint32')
      pass.drawIndexed(this.ring.count)
    }

    pass.end()
    this.device.queue.submit([enc.finish()])
  }

  screenshot(): string | null {
    try {
      this.render()
      return this.canvas.toDataURL('image/png')
    } catch {
      return null
    }
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    try {
      this.device?.destroy?.()
    } catch {
      /* noop */
    }
  }
}
