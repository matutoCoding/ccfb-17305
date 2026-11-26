// 极简 IndexedDB 封装：所有档案/测厚数据均存本地浏览器
const DB_NAME = 'pipeline-thinning-3d'
const DB_VERSION = 1

export const STORES = [
  'pipelines',
  'fittings',
  'points',
  'readings',
  'periods',
  'cscans',
  'badrows',
  'batches',
  'suggestions',
  'meta'
] as const
export type StoreName = (typeof STORES)[number]

let dbPromise: Promise<IDBDatabase> | null = null

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) {
          db.createObjectStore(s, { keyPath: s === 'meta' ? 'key' : 'id' })
        }
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const os = t.objectStore(store)
        const r = fn(os)
        r.onsuccess = () => resolve(r.result)
        r.onerror = () => reject(r.error)
      })
  )
}

export async function getAll<T = any>(store: StoreName): Promise<T[]> {
  return tx(store, 'readonly', (os) => os.getAll() as IDBRequest<T[]>)
}

export async function get<T = any>(store: StoreName, id: string): Promise<T | undefined> {
  return tx(store, 'readonly', (os) => os.get(id) as IDBRequest<T | undefined>)
}

export async function put(store: StoreName, value: any): Promise<void> {
  await tx(store, 'readwrite', (os) => os.put(value))
}

export async function bulkPut(store: StoreName, values: any[]): Promise<void> {
  if (!values.length) return
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    const os = t.objectStore(store)
    for (const v of values) os.put(v)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

export async function remove(store: StoreName, id: string): Promise<void> {
  await tx(store, 'readwrite', (os) => os.delete(id))
}

export async function clearStore(store: StoreName): Promise<void> {
  await tx(store, 'readwrite', (os) => os.clear())
}

export async function getMeta<T = any>(key: string): Promise<T | undefined> {
  const row = await get<{ key: string; value: T }>('meta', key)
  return row?.value
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await put('meta', { key, value })
}

export async function clearAllData(): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([...STORES], 'readwrite')
    for (const s of STORES) t.objectStore(s).clear()
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}
