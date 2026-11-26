/**
 * 生成演示数据并写入 public/demo-seed.json，
 * 前端首启时读取并灌入 IndexedDB。
 * 用法：npm run generate
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSeed } from './generator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, '../public/demo-seed.json');

const seed = generateSeed();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(seed));

const counts = (arr: { length: number }) => arr.length;
console.log('演示数据已生成:', out);
console.log(`  管线 ${counts(seed.pipelines)} 条`);
console.log(`  管件 ${counts(seed.fittings)} 个`);
console.log(`  测点 ${counts(seed.points)} 个`);
console.log(`  期次 ${counts(seed.rounds)}，读数 ${counts(seed.readings)} 条`);
console.log(`  坏行 ${counts(seed.badRows)}，C 扫描网格 ${counts(seed.cscans)}`);
console.log(`  埋入外弧减薄点 ${seed.thinningSpots.length} 处:`,
  seed.thinningSpots.map((s) => `${s.lineNo}/${s.elbowTag}`).join(', '));
