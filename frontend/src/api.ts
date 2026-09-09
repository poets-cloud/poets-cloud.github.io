import type { Author, Dynasty, Manifest, WorkDetail, WorkIndex } from './types';

const DATA_BASE = '/data/web';

async function request<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export const getManifest = () => request<Manifest>(`${DATA_BASE}/manifest.json`);
export const getAuthors = () => request<Author[]>(`${DATA_BASE}/authors.index.json`);
export const getDynasties = () => request<Dynasty[]>(`${DATA_BASE}/dynasties.json`);
export const getWorkIndex = () => request<WorkIndex[]>(`${DATA_BASE}/works.index.json`);

const detailCache = new Map<string, WorkDetail>();
const bucketCache = new Map<string, Record<string, WorkDetail>>();

export async function getWorkDetail(work: WorkIndex): Promise<WorkDetail> {
  const cached = detailCache.get(work.id);
  if (cached) return cached;
  let bucket = bucketCache.get(work.bucket);
  if (!bucket) {
    bucket = await request<Record<string, WorkDetail>>(`${DATA_BASE}/works/${work.bucket}.json`);
    bucketCache.set(work.bucket, bucket);
  }
  const detail = bucket[work.id];
  if (!detail) throw new Error('找不到这首诗的详情');
  detailCache.set(work.id, detail);
  return detail;
}

export async function searchWorks(query: string, signal?: AbortSignal): Promise<WorkIndex[]> {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, '');
  if (!normalized) return [];
  const index = await getWorkIndex();
  return index.filter((work) => `${work.title}${work.authorName}${work.dynasty}${work.meter}${work.excerpt}`.toLowerCase().replace(/\s+/g, '').includes(normalized)).slice(0, 100);
}
