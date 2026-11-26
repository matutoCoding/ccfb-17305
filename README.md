# 管道定点测厚三维减薄分析系统

浏览器端运行的在役管道测厚管理与三维可视化系统，无需后端服务：
TypeScript + WebGPU 渲染与计算 + IndexedDB 本地存储。

## 启动

```bash
npm install
npm run generate   # 生成演示数据到 public/demo-seed.json
npm run dev        # 开发服务器
npm test           # 单元测试（几何/插值/寿命/导入，14 项）
npm run e2e        # 浏览器端到端不变量验证（需系统 Chrome）
npm run build      # 类型检查 + 生产构建
```

首次打开页面自动把演示数据灌入 IndexedDB，顶栏可随时重置。

## 六个页面

| 页面 | 能力 |
| --- | --- |
| 管线档案 | 装置/单元/管线号建档，DN+壁厚等级自动带出外径与名义壁厚（ASME B36.10M），材质许用应力、腐蚀裕量、图纸总长 |
| 等轴测建模 | 逐段录入直管/长半径短半径/45°弯头/三通/同心偏心大小头/法兰/阀门，自动扫三维，走向接不上、总长不符、测点越界实时报错 |
| 测厚数据 | 一期一 CSV 导入，坏行按 点号缺失/超名义壁厚/英寸单位/解析失败 四类单列；弯头外弧 C 扫描网格贴曲面；两期对比自动标记可疑增厚点 |
| 三维减薄图 | WebGPU 计算着色器跑 IDW 插值，剩余壁厚比/长短期速率/两期差值四种云图，外壁半透明、任意位置剖切截面圆环、点击测点看历次读数 |
| 寿命评估 | B31.3 内压公式 + 腐蚀裕量算 tmin（弯头 ×1.25），API570 长短期速率、剩余寿命、下次检验日期，点行跳转三维位置 |
| 检验计划 | 剩余寿命 <2 周期、弯头外弧盲区、三通肩部、注水点下游自动筛选，建议加点直接给三维落点，导出带等轴测截图的 CSV/HTML 任务单 |

## 关键正确性约束（均有测试钉住）

1. **测点落点 <2% 管径**：钟点基准由流向与世界正上方按 `sectionFrame` 定死，
   弯头按弧长 s + 周向角 θ 定位，`test/geometry.test.ts` 断言偏差为 0。
2. **外弧减薄绝不污染内弧**：每个管件是独立参数域，IDW 只在同域样本间进行；
   距离用管面度量 `d²=ds²+(R·dθ)²`，θ 取圆周最短角，不穿过管心、不跨法兰/焊口。
   CPU 参考实现 (`src/thickness/field.ts`) 与 WGSL 计算着色器 (`src/webgpu/shaders.ts`) 同公式。
3. **三维数字与导出表同源**：拾取弹窗、剖切圆环、寿命表、检验计划全部读同一个
   `assessment` / `ThicknessField` 结果，不存在两套口径。

## 目录结构

```
src/
  math/vector.ts        向量、钟点<->θ、截面基准
  geometry/centerline.ts 中心线/弯头圆心/域划分/落点
  geometry/placement.ts 测点三维落点 + 表面度量
  geometry/mesh.ts      管壁渲染网格（顶点带 domain/s/theta 属性）
  thickness/field.ts    CPU IDW 壁厚场（WGSL 的参考实现）
  thickness/life.ts     API570 寿命评估
  thickness/diff.ts     两期差值与可疑点
  thickness/inspection.ts 检验计划与建议加点
  thickness/csv-import.ts CSV/C扫描导入与坏行分类
  webgpu/               引擎、WGSL、相机、Canvas2D 退化渲染器
  state/store.ts        全局状态，串联几何/场/评估，保证同源
  app/                  Preact 页面与三维视图
scripts/generator.ts    演示数据生成（38 管线/664 管件/1510 测点/4 期/5 处外弧减薄）
```

无 WebGPU 的环境自动降级到 Canvas2D 渲染，数据口径不变。
