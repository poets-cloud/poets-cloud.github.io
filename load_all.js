const API_BASE = '';

async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.json();
}

async function loadAllWorks() {
  const manifest = await apiGet('/api/manifest');
  const batchSize = 5000;
  const total = manifest.work_count || manifest.workCount || 0;
  const works = [];
  for (let offset = 0; offset < total; offset += batchSize) {
    const data = await apiGet(`/api/works?limit=${batchSize}&offset=${offset}`);
    works.push(...data.items);
    console.log(`loaded ${works.length}/${total}`);
  }
  return works;
}

loadAllWorks().then((works) => {
  console.log('loaded works', works.length);
}).catch((error) => {
  console.error(error);
});
