/**
 * IndexedDB 持久化（idb 封装）。
 * 库名 pipe-tml，所有档案与历次测厚数据本地存储，不依赖服务端。
 */
import { openDB, type IDBPDatabase } from 'idb';
import {
  BadRow,
  CScanGrid,
  Fitting,
  InspectionRound,
  Pipeline,
  ThicknessPoint,
  ThicknessReading,
} from '../types';

const DB_NAME = 'pipe-tml-db';
const DB_VERSION = 1;

export const STORES = {
  pipelines: 'pipelines',
  fittings: 'fittings',
  points: 'points',
  rounds: 'rounds',
  readings: 'readings',
  badRows: 'badRows',
  cscans: 'cscans',
  meta: 'meta',
} as const;

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore(STORES.pipelines, { keyPath: 'id' });
        const fit = db.createObjectStore(STORES.fittings, { keyPath: 'id' });
        fit.createIndex('pipelineId', 'pipelineId');
        fit.createIndex('tag', 'tag');
        const pt = db.createObjectStore(STORES.points, { keyPath: 'id' });
        pt.createIndex('pipelineId', 'pipelineId');
        pt.createIndex('fittingId', 'fittingId');
        pt.createIndex('pointNo', 'pointNo', { unique: true });
        db.createObjectStore(STORES.rounds, { keyPath: 'id' });
        const rd = db.createObjectStore(STORES.readings, { keyPath: 'id' });
        rd.createIndex('roundId', 'roundId');
        rd.createIndex('pointNo', 'pointNo');
        const br = db.createObjectStore(STORES.badRows, { keyPath: 'id' });
        br.createIndex('roundId', 'roundId');
        const cs = db.createObjectStore(STORES.cscans, { keyPath: 'id' });
        cs.createIndex('fittingId', 'fittingId');
        db.createObjectStore(STORES.meta, { keyPath: 'key' });
      },
    });
  }
  return dbPromise;
}

export const repo = {
  async putPipeline(p: Pipeline) {
    const db = await getDB();
    await db.put(STORES.pipelines, p);
  },
  async listPipelines(): Promise<Pipeline[]> {
    const db = await getDB();
    return db.getAll(STORES.pipelines);
  },
  async getPipeline(id: string): Promise<Pipeline | undefined> {
    const db = await getDB();
    return db.get(STORES.pipelines, id);
  },
  async deletePipeline(id: string) {
    const db = await getDB();
    const tx = db.transaction(
      [STORES.pipelines, STORES.fittings, STORES.points], 'readwrite',
    );
    await tx.objectStore(STORES.pipelines).delete(id);
    const fitStore = tx.objectStore(STORES.fittings);
    const fitIdx = fitStore.index('pipelineId');
    const fitKeys = await fitIdx.getAllKeys(id);
    await Promise.all(fitKeys.map((k) => fitStore.delete(k)));
    const ptStore = tx.objectStore(STORES.points);
    const ptIdx = ptStore.index('pipelineId');
    const ptKeys = await ptIdx.getAllKeys(id);
    await Promise.all(ptKeys.map((k) => ptStore.delete(k)));
    await tx.done;
  },

  async putFitting(f: Fitting) {
    const db = await getDB();
    await db.put(STORES.fittings, f);
  },
  async putFittings(list: Fitting[]) {
    const db = await getDB();
    const tx = db.transaction(STORES.fittings, 'readwrite');
    await Promise.all(list.map((f) => tx.store.put(f)));
    await tx.done;
  },
  async listFittings(pipelineId: string): Promise<Fitting[]> {
    const db = await getDB();
    return db.getAllFromIndex(STORES.fittings, 'pipelineId', pipelineId);
  },
  async deleteFitting(id: string) {
    const db = await getDB();
    await db.delete(STORES.fittings, id);
  },

  async putPoint(p: ThicknessPoint) {
    const db = await getDB();
    await db.put(STORES.points, p);
  },
  async putPoints(list: ThicknessPoint[]) {
    const db = await getDB();
    const tx = db.transaction(STORES.points, 'readwrite');
    await Promise.all(list.map((p) => tx.store.put(p)));
    await tx.done;
  },
  async listPoints(pipelineId: string): Promise<ThicknessPoint[]> {
    const db = await getDB();
    return db.getAllFromIndex(STORES.points, 'pipelineId', pipelineId);
  },
  async allPoints(): Promise<ThicknessPoint[]> {
    const db = await getDB();
    return db.getAll(STORES.points);
  },

  async putRound(r: InspectionRound) {
    const db = await getDB();
    await db.put(STORES.rounds, r);
  },
  async listRounds(): Promise<InspectionRound[]> {
    const db = await getDB();
    return db.getAll(STORES.rounds);
  },

  async addReadings(list: ThicknessReading[]) {
    if (list.length === 0) return;
    const db = await getDB();
    const tx = db.transaction(STORES.readings, 'readwrite');
    await Promise.all(list.map((r) => tx.store.put(r)));
    await tx.done;
  },
  async listReadings(roundId: string): Promise<ThicknessReading[]> {
    const db = await getDB();
    return db.getAllFromIndex(STORES.readings, 'roundId', roundId);
  },
  async allReadings(): Promise<ThicknessReading[]> {
    const db = await getDB();
    return db.getAll(STORES.readings);
  },

  async addBadRows(list: BadRow[]) {
    if (list.length === 0) return;
    const db = await getDB();
    const tx = db.transaction(STORES.badRows, 'readwrite');
    await Promise.all(list.map((r) => tx.store.put(r)));
    await tx.done;
  },
  async listBadRows(roundId?: string): Promise<BadRow[]> {
    const db = await getDB();
    return roundId
      ? db.getAllFromIndex(STORES.badRows, 'roundId', roundId)
      : db.getAll(STORES.badRows);
  },

  async putCScan(g: CScanGrid) {
    const db = await getDB();
    await db.put(STORES.cscans, g);
  },
  async listCScan(fittingId?: string): Promise<CScanGrid[]> {
    const db = await getDB();
    return fittingId
      ? db.getAllFromIndex(STORES.cscans, 'fittingId', fittingId)
      : db.getAll(STORES.cscans);
  },

  async setMeta(key: string, value: unknown) {
    const db = await getDB();
    await db.put(STORES.meta, { key, value });
  },
  async getMeta<T>(key: string): Promise<T | undefined> {
    const db = await getDB();
    const row = await db.get(STORES.meta, key);
    return row?.value as T | undefined;
  },

  async exportAll(): Promise<string> {
    const db = await getDB();
    const dump: Record<string, unknown[]> = {};
    for (const s of Object.values(STORES)) {
      if (s === STORES.meta) continue;
      dump[s] = await db.getAll(s);
    }
    return JSON.stringify(dump, null, 2);
  },
};

export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
