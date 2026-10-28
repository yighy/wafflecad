// Projects saved in this browser (IndexedDB: far more room than localStorage, which large
// imported drawings would fill). The list of projects and their documents are kept apart, so
// the gallery opens without reading every document.
import type { CadDocument } from "./types";

export interface ProjectMeta {
  id: string;
  name: string;
  created: number;
  updated: number;
  /** Small picture of the model (data URL), taken while it was being edited. */
  thumb?: string;
  /** An assembly of other projects (none: a part). */
  kind?: "assembly";
  /** The tab it is in, in Projects (none: the first one). */
  group?: string;
}

const DB_NAME = "waffle";
const META = "projects";
const DOCS = "documents";

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(META, { keyPath: "id" });
      req.result.createObjectStore(DOCS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function tx(stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => void) {
  const t = (await db()).transaction(stores, mode);
  run(t);
  await new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error);
  });
}

/** Most recently edited first. */
export async function listProjects(): Promise<ProjectMeta[]> {
  const all = await done((await db()).transaction(META).objectStore(META).getAll() as IDBRequest<ProjectMeta[]>);
  return all.sort((a, b) => b.updated - a.updated);
}

export async function getProject(id: string): Promise<{ meta: ProjectMeta; doc: CadDocument } | null> {
  const t = (await db()).transaction([META, DOCS]);
  const [meta, doc] = await Promise.all([
    done(t.objectStore(META).get(id) as IDBRequest<ProjectMeta | undefined>),
    done(t.objectStore(DOCS).get(id) as IDBRequest<CadDocument | undefined>),
  ]);
  return meta && doc ? { meta, doc } : null;
}

/** Saves the project's details, and its document when given. */
export function putProject(meta: ProjectMeta, doc?: CadDocument) {
  return tx(doc ? [META, DOCS] : [META], "readwrite", (t) => {
    t.objectStore(META).put(meta);
    if (doc) t.objectStore(DOCS).put(doc, meta.id);
  });
}

export function deleteProject(id: string) {
  return tx([META, DOCS], "readwrite", (t) => {
    t.objectStore(META).delete(id);
    t.objectStore(DOCS).delete(id);
  });
}

export const newProjectId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** "Model 3" when "Model 1" and "Model 2" exist. */
export function freeName(prefix: string, taken: string[]) {
  let i = 1;
  while (taken.includes(`${prefix} ${i}`)) i++;
  return `${prefix} ${i}`;
}
