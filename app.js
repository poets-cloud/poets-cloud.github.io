import * as THREE from './node_modules/three/build/three.module.js';

let manifest;
let poems = [];
let nodes = [];
let authors = [];
let dynasties = [];
let categories = [];
let filteredPoems = [];
let selectedId = null;
let activeMeter = '全部';
let activeDynasty = '全部';
let activeAuthor = '全部';
let searchTerm = '';
let searchMatchIds = null;
let searchRequestVersion = 0;
let largeDatasetMode = false;

const DATA_BASE = new URL('./', document.baseURI);
const SEARCH_BUCKET_COUNT = 64;
const detailBucketCache = new Map();
let searchCorpusPromise = null;

const searchInput = document.getElementById('searchInput');
const meterFilters = document.getElementById('meterFilters');
const resultsEl = document.getElementById('results');
const detailEl = document.getElementById('detailContent');
const resultCountEl = document.getElementById('resultCount');
const statsEl = document.getElementById('stats');
const clearSelectionBtn = document.getElementById('clearSelection');
const resetViewBtn = document.getElementById('resetView');
const toggleFiltersBtn = document.getElementById('toggleFilters');
const controlPanelEl = document.getElementById('controlPanel');
const cloudEl = document.querySelector('.cloud');
const canvas3d = document.getElementById('cloudCanvas3d');
const debugOverlay = document.getElementById('debugOverlay');
const cloudLabelsEl = document.getElementById('cloudLabels');
const cloudTooltipEl = document.getElementById('cloudTooltip');
const levelNavEl = document.getElementById('levelNav');
const levelTitleEl = document.getElementById('levelTitle');
const levelDescriptionEl = document.getElementById('levelDescription');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const MAX_VISIBLE_AUTHORS = 48;
const MAX_VISIBLE_POEMS = 28;
const OVERVIEW_PREVIEW_AUTHORS = 12;

const state = {
  width: 0,
  height: 0,
  ratio: 1,
  scene: null,
  camera: null,
  renderer: null,
  raycaster: null,
  pointer: new THREE.Vector2(),
  frame: 0,
  drag: { active: false, moved: false, suppressClick: false, mode: 'rotate', x: 0, y: 0 },
  orbit: { radius: 820, theta: 0.25, phi: 0.66 },
  viewMode: 'overview',
  focusedDynasty: null,
  trackedAuthorKey: null,
  orbitTarget: new THREE.Vector3(0, 0, 0),
  cameraTarget: new THREE.Vector3(0, 0, 820),
  cameraLookTarget: new THREE.Vector3(0, 0, 0),
  dynastyGroups: new Map(),
  authorGroups: new Map(),
  poemMeshes: [],
  poemMeshById: new Map(),
  poemPoints: null,
  poemPointIds: [],
  poemPointIndexById: new Map(),
  poemBasePositions: null,
  poemBaseScales: null,
  focusPoemMeshes: [],
  focusPoemMeshById: new Map(),
  focusGroup: null,
  focusAmbientPoints: null,
  focusOrbitLines: [],
  authorMarkers: [],
  dynastyMarkers: [],
  dynastyDust: new Map(),
  orbitLines: [],
  relationLines: [],
  decorativeLines: [],
  glows: [],
  starField: null,
  nodeGroup: null,
  hoveredId: null,
  hoveredPoemId: null,
  hoveredAuthorKey: null,
  hoveredDynasty: null,
  pointerClient: { x: 0, y: 0 },
  visibleIds: new Set(),
  visibleAuthorKeys: new Set(),
  startedAt: performance.now(),
  lastMotionAt: performance.now(),
};

function setDebug(message) { if (debugOverlay) debugOverlay.textContent = message; }
function normalizeText(text) { return (text || '').toLowerCase().replace(/\s+/g, ''); }
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function colorFromHash(text, saturation = 72, lightness = 60) {
  const hue = hashString(text) % 360;
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}
function colorFromHue(hue, saturation = 72, lightness = 60) {
  return `hsl(${((hue % 360) + 360) % 360}, ${saturation}%, ${lightness}%)`;
}

function stabilizeOrbit() {
  state.orbit.radius = clamp(state.orbit.radius, 320, 1400);
  state.orbit.phi = clamp(state.orbit.phi, 0.34, 1.18);
  const limit = Math.PI * 2;
  if (state.orbit.theta > limit || state.orbit.theta < -limit) {
    state.orbit.theta = ((state.orbit.theta % limit) + limit) % limit;
  }
}

function updateCameraFromOrbit() {
  const { radius, theta, phi } = state.orbit;
  const sinPhi = Math.sin(phi);
  state.cameraTarget.set(
    state.orbitTarget.x + radius * Math.sin(theta) * sinPhi,
    state.orbitTarget.y + radius * Math.cos(phi),
    state.orbitTarget.z + radius * Math.cos(theta) * sinPhi,
  );
}

function setOverviewMode() {
  state.viewMode = 'overview';
  state.focusedDynasty = null;
  state.trackedAuthorKey = null;
  state.orbit.radius = 900;
  state.orbit.theta = 0.08;
  state.orbit.phi = 1.05;
  state.orbitTarget.set(0, 0, 0);
  state.cameraLookTarget.set(0, 0, 0);
  stabilizeOrbit();
  updateCameraFromOrbit();
  clearFocusSystem();
  renderLevelNavigation();
}

function setDynastyMode(dynasty) {
  const dynastyGroup = typeof dynasty === 'string' ? state.dynastyGroups.get(dynasty) : dynasty;
  if (!dynastyGroup) return;
  state.viewMode = 'dynasty';
  state.focusedDynasty = dynastyGroup.dynasty;
  state.trackedAuthorKey = null;
  state.orbit.radius = 520;
  state.orbit.theta = 0.32;
  state.orbit.phi = 0.72;
  state.orbitTarget.copy(dynastyGroup.center);
  state.cameraLookTarget.copy(dynastyGroup.center);
  stabilizeOrbit();
  updateCameraFromOrbit();
  clearFocusSystem();
  renderLevelNavigation();
}

function setFocusMode(authorGroup) {
  state.viewMode = 'author';
  state.focusedDynasty = authorGroup.dynasty;
  state.trackedAuthorKey = `${authorGroup.dynasty}:${authorGroup.authorName}`;
  state.orbit.radius = 330;
  state.orbit.theta = 0.55;
  state.orbit.phi = 0.82;
  state.orbitTarget.copy(authorGroup.center);
  state.cameraLookTarget.copy(authorGroup.center);
  stabilizeOrbit();
  updateCameraFromOrbit();
  buildFocusSystem(authorGroup);
  renderLevelNavigation();
}

function renderLevelNavigation() {
  if (!levelNavEl) return;
  const dynastyButton = levelNavEl.querySelector('[data-level="dynasty"]');
  const authorButton = levelNavEl.querySelector('[data-level="author"]');
  const overviewButton = levelNavEl.querySelector('[data-level="overview"]');
  const authorGroup = state.trackedAuthorKey ? state.authorGroups.get(state.trackedAuthorKey) : null;
  overviewButton.classList.toggle('active', state.viewMode === 'overview');
  dynastyButton.disabled = !state.focusedDynasty;
  dynastyButton.textContent = state.focusedDynasty || '选择朝代';
  dynastyButton.classList.toggle('active', state.viewMode === 'dynasty');
  authorButton.disabled = !authorGroup;
  authorButton.textContent = authorGroup?.authorName || '选择诗人';
  authorButton.classList.toggle('active', state.viewMode === 'author');
  if (levelTitleEl && levelDescriptionEl) {
    if (state.viewMode === 'overview') {
      levelTitleEl.textContent = '朝代星系';
      levelDescriptionEl.textContent = '选择一个朝代进入；诗人和诗作将在下一层出现';
    } else if (state.viewMode === 'dynasty') {
      const dynastyGroup = state.dynastyGroups.get(state.focusedDynasty);
      const visibleAuthors = state.authorMarkers.filter((item) => item.dynasty === state.focusedDynasty && item.rank < MAX_VISIBLE_AUTHORS).length;
      levelTitleEl.textContent = `${state.focusedDynasty}代诗人`;
      levelDescriptionEl.textContent = `显示 ${visibleAuthors} 位代表诗人，其余作者以星雾保留空间密度`;
      if (dynastyGroup) dynastyGroup.lastVisitedAt = performance.now();
    } else if (authorGroup) {
      levelTitleEl.textContent = `${authorGroup.authorName}星系`;
      levelDescriptionEl.textContent = `显示 ${state.focusPoemMeshes.length} 首诗作，其余作品聚合为不可交互星尘`;
    }
  }
}

function resize() {
  const width = cloudEl.clientWidth;
  const height = cloudEl.clientHeight;
  if (!width || !height || !state.renderer) return;
  state.width = width;
  state.height = height;
  state.ratio = Math.min(window.devicePixelRatio || 1, 2);
  state.renderer.setSize(width, height, false);
  state.renderer.setPixelRatio(state.ratio);
  state.camera.aspect = width / height;
  state.camera.updateProjectionMatrix();
}

function renderStats() {
  const dynastyCount = dynasties.length || new Set(poems.map((p) => p.dynasty)).size;
  statsEl.innerHTML = `<div class="stat">作品 ${manifest.work_count || manifest.workCount || manifest.poemCount || poems.length}</div><div class="stat">作者 ${manifest.authorCount || authors.length}</div><div class="stat">朝代 ${dynastyCount}</div>`;
}

function renderFilters() {
  const meterItems = ['全部', ...new Set(poems.map((p) => p.meter))];
  const dynastyItems = ['全部', ...new Set(dynasties.length ? dynasties.map((d) => d.name) : poems.map((p) => p.dynasty))];
  const featuredAuthorItems = [...new Set(poems.map((p) => p.authorName)).values()].slice(0, 17);
  if (activeAuthor !== '全部' && !featuredAuthorItems.includes(activeAuthor)) featuredAuthorItems.unshift(activeAuthor);
  const authorItems = ['全部', ...featuredAuthorItems.slice(0, 18)];
  meterFilters.innerHTML = [
    '<div class="filter-group"><span class="filter-label">格律</span>' + meterItems.map((item) => `<button class="filter-btn ${item === activeMeter ? 'active' : ''}" data-type="meter" data-value="${item}">${item}</button>`).join('') + '</div>',
    '<div class="filter-group"><span class="filter-label">朝代</span>' + dynastyItems.map((item) => `<button class="filter-btn ${item === activeDynasty ? 'active' : ''}" data-type="dynasty" data-value="${item}">${item}</button>`).join('') + '</div>',
    '<div class="filter-group"><span class="filter-label">诗人</span>' + authorItems.map((item) => `<button class="filter-btn ${item === activeAuthor ? 'active' : ''}" data-type="author" data-value="${item}">${item}</button>`).join('') + '</div>',
  ].join('');

  meterFilters.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { type, value } = btn.dataset;
      if (type === 'meter') activeMeter = value;
      if (type === 'dynasty') {
        activeDynasty = value;
        activeAuthor = '全部';
        if (value === '全部') setOverviewMode();
        else setDynastyMode(value);
      }
      if (type === 'author') {
        activeAuthor = value;
        if (value === '全部') {
          if (activeDynasty !== '全部') setDynastyMode(activeDynasty);
        } else {
          const authorGroup = state.authorMarkers.find((item) => item.authorName === value && (activeDynasty === '全部' || item.dynasty === activeDynasty));
          if (authorGroup) setFocusMode(authorGroup);
        }
      }
      renderFilters();
      applyFilters();
    });
  });
}

function updateVisibilityIndex() {
  state.visibleIds = new Set(filteredPoems.map((poem) => poem.id));
  state.visibleAuthorKeys = new Set(filteredPoems.map((poem) => `${poem.dynasty}:${poem.authorName}`));
}

function applyFilters() {
  const term = normalizeText(searchTerm);
  filteredPoems = poems.filter((poem) => {
    const meterOk = activeMeter === '全部' || poem.meter === activeMeter;
    const dynastyOk = activeDynasty === '全部' || poem.dynasty === activeDynasty;
    const authorOk = activeAuthor === '全部' || poem.authorName === activeAuthor;
    const text = [poem.title, poem.authorName, poem.dynasty, poem.normalizedContent, poem.tags.join(' ')].join('');
    const searchOk = !term || (searchMatchIds ? searchMatchIds.has(poem.id) : normalizeText(text).includes(term));
    return meterOk && dynastyOk && authorOk && searchOk;
  });
  updateVisibilityIndex();
  if (state.viewMode === 'author' && state.trackedAuthorKey) {
    const authorGroup = state.authorGroups.get(state.trackedAuthorKey);
    if (authorGroup) buildFocusSystem(authorGroup);
  }
  renderResults();
  render3D();
}

function renderResults() {
  resultCountEl.textContent = `${filteredPoems.length} 条`;
  resultsEl.innerHTML = filteredPoems.slice(0, 120).map((poem) => `
    <button class="result-item ${poem.id === selectedId ? 'selected' : ''}" data-id="${poem.id}">
      <div class="result-title">${poem.title}</div>
      <div class="result-meta">${poem.authorName} · ${poem.dynasty} · ${poem.meter}</div>
      <div class="result-meta">${poem.excerpt || ''}</div>
    </button>
  `).join('');
  resultsEl.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => selectPoem(btn.dataset.id)));
}

async function selectPoem(id) {
  selectedId = id;
  let poem = poems.find((item) => item.id === id);
  try {
    if (!poem) throw new Error('找不到这首诗的索引');
    const detail = await loadWorkDetail(poem);
    Object.assign(poem, {
      id: detail.id,
      title: detail.title,
      authorName: detail.author_name || detail.authorName,
      dynasty: detail.dynasty,
      meter: detail.meter,
      rhythmic: detail.rhythmic,
      lines: detail.lines,
      tags: detail.tags,
      content: detail.content || (detail.lines || []).join(''),
      normalizedContent: normalizeText(detail.content || (detail.lines || []).join('')),
      excerpt: detail.lines?.[0] || '',
      importance: detail.importance,
    });
  } catch (error) {
    setDebug(`详情加载失败：${error.message}`);
  }
  if (!poem) return;
  detailEl.innerHTML = `
    <h3 class="poem-title">${poem.title}</h3>
    <div class="poem-meta">${poem.authorName} · ${poem.dynasty} · ${poem.meter}</div>
    <div class="poem-body">${(poem.lines || []).join('<br/>')}</div>
    <div class="poem-meta" style="margin-top:14px;">标签：${poem.tags && poem.tags.length ? poem.tags.join(' / ') : '无'}</div>
  `;
  focusOnPoem(poem);
  renderResults();
  render3D();
}

function clearSelection() {
  selectedId = null;
  detailEl.textContent = '请选择一首诗查看内容。';
  renderResults();
  render3D();
}

function resetView() {
  searchTerm = '';
  searchMatchIds = null;
  searchRequestVersion += 1;
  activeMeter = '全部';
  activeDynasty = '全部';
  activeAuthor = '全部';
  selectedId = null;
  searchInput.value = '';
  setOverviewMode();
  renderFilters();
  applyFilters();
  detailEl.textContent = '请选择一首诗查看内容。';
}

function computeHierarchy() {
  const dynastyNames = [...new Set(poems.map((p) => p.dynasty))];
  const dynastyRadiusX = 430;
  const dynastyRadiusZ = 335;
  const dynastyAngleStep = (Math.PI * 2) / Math.max(1, dynastyNames.length);
  state.dynastyGroups.clear();
  state.authorGroups.clear();
  state.poemMeshes = [];
  state.authorMarkers = [];
  state.dynastyMarkers = [];
  largeDatasetMode = poems.length > 3000;
  state.poemBasePositions = largeDatasetMode ? new Float32Array(poems.length * 3) : null;
  state.poemBaseScales = largeDatasetMode ? new Float32Array(poems.length) : null;

  dynastyNames.forEach((dynasty, dIndex) => {
    const dAngle = dIndex * dynastyAngleStep;
    const overviewGrid = [
      [-255, 105, 30],
      [245, 92, -35],
      [-220, -125, 20],
      [225, -138, -10],
    ];
    const gridPosition = dynastyNames.length <= 4 ? overviewGrid[dIndex] : null;
    const dCenter = gridPosition
      ? new THREE.Vector3(...gridPosition)
      : new THREE.Vector3(Math.cos(dAngle) * dynastyRadiusX, Math.sin(dAngle * 2) * 34, Math.sin(dAngle) * dynastyRadiusZ);
    const hue = (hashString(dynasty) % 360);
    const dynastySeed = hashString(dynasty);
    const dynastyObj = {
      dynasty, center: dCenter, baseCenter: dCenter.clone(), index: dIndex, hue,
      phase: dAngle, orbitPhase: dAngle, orbitSpeed: 0.000018 + (dynastySeed % 17) * 0.00000045,
      orbitRadiusX: dynastyRadiusX * (0.94 + (dynastySeed % 9) * 0.012),
      orbitRadiusZ: dynastyRadiusZ * (0.94 + ((dynastySeed >>> 4) % 9) * 0.012),
      orbitTilt: THREE.MathUtils.degToRad(-5 + ((dynastySeed >>> 8) % 11)), mesh: null, glow: null, cloudGlow: null,
    };
    state.dynastyGroups.set(dynasty, dynastyObj);
    state.dynastyMarkers.push(dynastyObj);
  });

  const byDynasty = new Map();
  poems.forEach((poem) => {
    if (!byDynasty.has(poem.dynasty)) byDynasty.set(poem.dynasty, []);
    byDynasty.get(poem.dynasty).push(poem);
  });

  for (const [dynasty, dynastyPoems] of byDynasty.entries()) {
    const authorsInDynasty = [...new Set(dynastyPoems.map((p) => p.authorName))];
    const dynastyInfo = state.dynastyGroups.get(dynasty);
    dynastyInfo.poemCount = dynastyPoems.length;
    dynastyInfo.authorCount = authorsInDynasty.length;
    const authorRing = Math.min(230, Math.max(115, authorsInDynasty.length * 14));
    authorsInDynasty.forEach((authorName, aIndex) => {
      const aAngle = (aIndex / Math.max(1, authorsInDynasty.length)) * Math.PI * 2;
      const authorCenter = new THREE.Vector3(
        dynastyInfo.center.x + Math.cos(aAngle) * authorRing,
        Math.sin(aAngle * 2) * 26,
        dynastyInfo.center.z + Math.sin(aAngle) * authorRing,
      );
      const authorHue = (dynastyInfo.hue + aIndex * 9) % 360;
      const authorSeed = hashString(`${dynasty}:${authorName}`);
      const authorObj = {
        dynasty, authorName, center: authorCenter, baseCenter: authorCenter.clone(), poems: [], mesh: null, glow: null,
        hue: authorHue, phase: aAngle + (authorSeed % 100) / 100, orbitPhase: aAngle,
        orbitRadiusX: authorRing * (0.84 + (authorSeed % 23) / 100),
        orbitRadiusZ: authorRing * (0.72 + ((authorSeed >>> 5) % 25) / 100),
        orbitSpeed: (0.000042 + ((authorSeed >>> 9) % 31) * 0.0000008) * (authorSeed % 7 === 0 ? -1 : 1),
        orbitTilt: THREE.MathUtils.degToRad(-16 + ((authorSeed >>> 14) % 33)),
      };
      state.authorGroups.set(`${dynasty}:${authorName}`, authorObj);
      state.authorMarkers.push(authorObj);
    });
  }

  poems.forEach((poem, index) => {
    poem._index = index;
    const authorKey = `${poem.dynasty}:${poem.authorName}`;
    const authorGroup = state.authorGroups.get(authorKey);
    if (!authorGroup) return;
    const siblingIndex = authorGroup.poems.length;
    const baseRing = 28 + Math.min(34, siblingIndex * 0.85);
    const angle = siblingIndex * 0.82;
    const height = (siblingIndex % 9 - 4) * 3.1;
    const local = new THREE.Vector3(Math.cos(angle) * baseRing, height, Math.sin(angle) * baseRing);
    poem._localPosition = local.clone();
    poem._position = authorGroup.center.clone().add(local);
    const poemSeed = hashString(poem.id);
    poem._phase = (poemSeed % 628) / 100;
    poem._orbitRadiusX = baseRing * (0.82 + (poemSeed % 31) / 100);
    poem._orbitRadiusZ = baseRing * (0.68 + ((poemSeed >>> 5) % 35) / 100);
    poem._orbitSpeed = (0.00009 + ((poemSeed >>> 10) % 55) * 0.0000017) * (poemSeed % 5 === 0 ? -1 : 1);
    poem._orbitTilt = THREE.MathUtils.degToRad(-32 + ((poemSeed >>> 16) % 65));
    poem._emphasis = (poem.tags && poem.tags.length ? 1.16 : 1) + Math.min(0.35, Math.log1p(index + 1) / 18);
    poem._hue = (authorGroup.hue + siblingIndex * 3) % 360;
    poem._visible = true;
    if (state.poemBasePositions) {
      const baseIndex = index * 3;
      state.poemBasePositions[baseIndex] = poem._position.x;
      state.poemBasePositions[baseIndex + 1] = poem._position.y;
      state.poemBasePositions[baseIndex + 2] = poem._position.z;
      state.poemBaseScales[index] = poem._emphasis;
    }
    authorGroup.poems.push(poem);
  });

  state.dynastyMarkers.forEach((dynastyInfo) => {
    const rankedAuthors = state.authorMarkers
      .filter((item) => item.dynasty === dynastyInfo.dynasty)
      .sort((a, b) => b.poems.length - a.poems.length || a.authorName.localeCompare(b.authorName, 'zh-CN'));
    rankedAuthors.forEach((author, rank) => {
      author.rank = rank;
      const angle = rank * 2.399963229728653;
      const radius = rank === 0 ? 42 : 58 + Math.sqrt(rank) * 31;
      author.previewAngle = angle;
      author.previewRadius = rank === 0 ? 44 : 62 + Math.sqrt(rank) * 18;
      author.previewTilt = THREE.MathUtils.degToRad(-20 + (hashString(`${author.dynasty}:${author.authorName}:preview`) % 41));
      author.previewSpeed = (0.000025 + (rank % 7) * 0.0000028) * (rank % 3 === 0 ? -1 : 1);
      author.center.set(
        dynastyInfo.center.x + Math.cos(angle) * radius,
        dynastyInfo.center.y + Math.sin(angle * 1.7) * 34,
        dynastyInfo.center.z + Math.sin(angle) * radius * 0.76,
      );
      author.baseCenter.copy(author.center);
      author.poems.forEach((poem) => {
        poem._position.copy(author.center).add(poem._localPosition);
        const poemIndex = poem._index;
        if (state.poemBasePositions && poemIndex >= 0) {
          const baseIndex = poemIndex * 3;
          state.poemBasePositions[baseIndex] = poem._position.x;
          state.poemBasePositions[baseIndex + 1] = poem._position.y;
          state.poemBasePositions[baseIndex + 2] = poem._position.z;
        }
      });
    });
  });

  const largestDynasty = Math.max(1, ...state.dynastyMarkers.map((item) => item.poemCount || 0));
  state.dynastyMarkers.forEach((item) => {
    item.visualScale = 0.9 + Math.sqrt((item.poemCount || 0) / largestDynasty) * 0.46;
  });
}

function createGlowTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0.0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.12, 'rgba(255,255,255,0.72)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.28)');
  gradient.addColorStop(0.65, 'rgba(255,255,255,0.08)');
  gradient.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const glowTexture = createGlowTexture();

function createGlow(color, size, opacity) {
  const material = new THREE.SpriteMaterial({
    color: new THREE.Color(color), transparent: true, opacity, depthWrite: false,
    blending: THREE.AdditiveBlending, map: glowTexture,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(size, size, 1);
  state.glows.push(sprite);
  return sprite;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function createDynastyDust() {
  state.dynastyDust.clear();
  state.dynastyMarkers.forEach((dynastyInfo) => {
    const dynastyPoems = poems.filter((poem) => poem.dynasty === dynastyInfo.dynasty);
    const pointCount = clamp(Math.round(Math.sqrt(dynastyPoems.length) * 3.2), 180, 900);
    const positions = new Float32Array(pointCount * 3);
    const random = seededRandom(hashString(`dust:${dynastyInfo.dynasty}`));
    for (let index = 0; index < pointCount; index += 1) {
      const angle = random() * Math.PI * 2;
      const radius = 54 + Math.pow(random(), 0.72) * 178;
      positions[index * 3] = Math.cos(angle) * radius;
      positions[index * 3 + 1] = (random() - 0.5) * 58 + Math.sin(angle * 2) * 8;
      positions[index * 3 + 2] = Math.sin(angle) * radius * 0.68;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: new THREE.Color(colorFromHue(dynastyInfo.hue, 72, 68)),
      size: 2.25,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const cloud = new THREE.Points(geometry, material);
    cloud.position.copy(dynastyInfo.center);
    cloud.userData = {
      type: 'ambient-dust', dynasty: dynastyInfo.dynasty,
      phase: (hashString(`dust-phase:${dynastyInfo.dynasty}`) % 628) / 100,
      speed: 0.000018 + (hashString(`dust-speed:${dynastyInfo.dynasty}`) % 17) * 0.0000012,
    };
    state.nodeGroup.add(cloud);
    state.dynastyDust.set(dynastyInfo.dynasty, cloud);
  });
}

function clearFocusSystem() {
  if (!state.focusGroup) return;
  state.focusGroup.traverse((object) => {
    if (object.geometry) object.geometry.dispose();
    if (object.material) {
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
      else object.material.dispose();
    }
  });
  state.focusGroup.clear();
  state.focusPoemMeshes = [];
  state.focusPoemMeshById.clear();
  state.focusAmbientPoints = null;
  state.focusOrbitLines = [];
}

function createFocusOrbit(center, radiusX, radiusZ, tilt, hue) {
  const points = [];
  for (let index = 0; index <= 112; index += 1) {
    const angle = (index / 112) * Math.PI * 2;
    const localZ = Math.sin(angle) * radiusZ;
    points.push(new THREE.Vector3(
      center.x + Math.cos(angle) * radiusX,
      center.y + Math.sin(tilt) * localZ,
      center.z + Math.cos(tilt) * localZ,
    ));
  }
  const line = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: new THREE.Color(colorFromHue(hue, 62, 68)), transparent: true, opacity: 0.13, depthWrite: false }),
  );
  line.userData = { type: 'focus-orbit' };
  state.focusGroup.add(line);
  state.focusOrbitLines.push(line);
}

function buildFocusSystem(authorGroup) {
  if (!state.focusGroup) return;
  clearFocusSystem();
  const visibleIds = state.visibleIds;
  const candidates = authorGroup.poems
    .filter((poem) => visibleIds.has(poem.id))
    .sort((a, b) => (b.id === selectedId) - (a.id === selectedId) || (b.importance || 0) - (a.importance || 0) || a.title.localeCompare(b.title, 'zh-CN'));
  const displayed = candidates.slice(0, MAX_VISIBLE_POEMS);
  const center = authorGroup.center;
  const ringSettings = [
    { x: 76, z: 48, tilt: -0.28 },
    { x: 118, z: 76, tilt: 0.42 },
    { x: 165, z: 105, tilt: -0.58 },
    { x: 214, z: 138, tilt: 0.22 },
  ];
  ringSettings.forEach((ring) => createFocusOrbit(center, ring.x, ring.z, ring.tilt, authorGroup.hue));

  const geometry = new THREE.SphereGeometry(2.1, 12, 12);
  const materialByMeter = new Map();
  displayed.forEach((poem, index) => {
    const ringIndex = index % ringSettings.length;
    const ring = ringSettings[ringIndex];
    const slot = Math.floor(index / ringSettings.length);
    const slotsInRing = Math.ceil(displayed.length / ringSettings.length);
    const angle = ((slot + ringIndex * 0.37) / Math.max(1, slotsInRing)) * Math.PI * 2;
    const localZ = Math.sin(angle) * ring.z;
    const meterKey = poem.meter || '其他';
    if (!materialByMeter.has(meterKey)) {
      const hue = meterKey === '词' ? 42 : meterKey.includes('绝') ? 198 : meterKey.includes('律') ? 265 : authorGroup.hue;
      materialByMeter.set(meterKey, new THREE.MeshBasicMaterial({ color: new THREE.Color(colorFromHue(hue, 88, 72)), transparent: true, opacity: 0.96 }));
    }
    const mesh = new THREE.Mesh(geometry, materialByMeter.get(meterKey));
    mesh.position.set(
      center.x + Math.cos(angle) * ring.x,
      center.y + Math.sin(ring.tilt) * localZ,
      center.z + Math.cos(ring.tilt) * localZ,
    );
    mesh.userData = { type: 'poem', id: poem.id, poem, focusIndex: index };
    mesh.scale.setScalar(poem.id === selectedId ? 2.1 : 1 + Math.min(0.55, (poem.importance || 0) * 0.22));
    state.focusGroup.add(mesh);
    state.focusPoemMeshes.push(mesh);
    state.focusPoemMeshById.set(poem.id, mesh);
  });

  const hiddenCount = Math.max(0, authorGroup.poems.length - displayed.length);
  const dustCount = clamp(hiddenCount * 4, 180, 900);
  const positions = new Float32Array(dustCount * 3);
  const random = seededRandom(hashString(`author-dust:${authorGroup.dynasty}:${authorGroup.authorName}`));
  for (let index = 0; index < dustCount; index += 1) {
    const ring = ringSettings[index % ringSettings.length];
    const angle = random() * Math.PI * 2;
    const spread = (random() - 0.5) * 34;
    const localZ = Math.sin(angle) * (ring.z + spread * 0.5);
    positions[index * 3] = center.x + Math.cos(angle) * (ring.x + spread);
    positions[index * 3 + 1] = center.y + Math.sin(ring.tilt) * localZ + (random() - 0.5) * 11;
    positions[index * 3 + 2] = center.z + Math.cos(ring.tilt) * localZ;
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const dustMaterial = new THREE.PointsMaterial({
    color: new THREE.Color(colorFromHue(authorGroup.hue, 74, 68)), size: 1.25, transparent: true, opacity: 0.14, depthWrite: false,
  });
  state.focusAmbientPoints = new THREE.Points(dustGeometry, dustMaterial);
  state.focusAmbientPoints.userData = { type: 'ambient-dust', author: authorGroup.authorName };
  state.focusGroup.add(state.focusAmbientPoints);
}

function createOrbitLine(center, radiusX, radiusZ, color, phase = 0) {
  const points = [];
  for (let i = 0; i <= 96; i += 1) {
    const angle = (i / 96) * Math.PI * 2;
    points.push(new THREE.Vector3(center.x + Math.cos(angle) * radiusX, center.y + Math.sin(angle * 2 + phase) * 7, center.z + Math.sin(angle) * radiusZ));
  }
  const line = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineDashedMaterial({ color, transparent: true, opacity: 0.105, dashSize: 8, gapSize: 13, depthWrite: false }),
  );
  line.computeLineDistances();
  state.orbitLines.push(line);
  state.nodeGroup.add(line);
}

function createDecorativeLines() {
  const colors = [0x667eea, 0x38bdf8, 0xa78bfa];
  for (let layer = 0; layer < 3; layer += 1) {
    const points = [];
    const turns = 2.25 + layer * 0.42;
    for (let i = 0; i <= 260; i += 1) {
      const progress = i / 260;
      const angle = progress * Math.PI * 2 * turns + layer * 2.1;
      const radius = 95 + progress * (470 + layer * 34);
      points.push(new THREE.Vector3(
        Math.cos(angle) * radius,
        Math.sin(angle * 1.65 + layer) * (14 + progress * 26),
        Math.sin(angle) * radius * (0.74 + layer * 0.035),
      ));
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineDashedMaterial({
        color: colors[layer], transparent: true, opacity: 0.04 + layer * 0.012,
        dashSize: 10 + layer * 3, gapSize: 18 + layer * 5, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    line.computeLineDistances();
    line.rotation.set(THREE.MathUtils.degToRad(-8 + layer * 9), layer * 0.7, THREE.MathUtils.degToRad(4 - layer * 5));
    line.userData = { speed: (layer % 2 ? -1 : 1) * (0.000018 + layer * 0.000006), phase: layer };
    state.decorativeLines.push(line);
    state.nodeGroup.add(line);
  }
}

function createRelationLines() {
  if (largeDatasetMode) return;
  state.authorMarkers.forEach((author) => {
    author.poems.forEach((poem) => {
      const geometry = new THREE.BufferGeometry().setFromPoints([author.center, poem._position]);
      const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
        color: new THREE.Color(colorFromHue(author.hue, 72, 68)),
        linewidth: 3, transparent: true, opacity: 0.04, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      line.userData = { author, poem };
      state.relationLines.push(line);
      state.nodeGroup.add(line);
    });
  });
}

function renderLabels(selectedAuthorKey, selectedDynasty) {
  if (!cloudLabelsEl || !state.camera) return;
  const labels = [];
  if (state.viewMode === 'overview') {
    state.dynastyMarkers.forEach((item) => labels.push({
      text: `${item.dynasty} · ${item.authorCount || 0} 位诗人`, position: item.mesh.position, kind: 'dynasty', active: item.dynasty === state.hoveredDynasty,
    }));
  } else if (state.viewMode === 'dynasty') {
    state.authorMarkers
      .filter((item) => item.dynasty === selectedDynasty && item.rank < 14 && item.mesh?.visible)
      .forEach((item) => labels.push({ text: item.authorName, position: item.mesh.position, kind: 'author', active: false }));
    const hovered = state.hoveredAuthorKey ? state.authorGroups.get(state.hoveredAuthorKey) : null;
    if (hovered && hovered.mesh?.visible && hovered.rank >= 14) {
      labels.push({ text: hovered.authorName, position: hovered.mesh.position, kind: 'author', active: true });
    }
  } else if (state.viewMode === 'author') {
    const author = selectedAuthorKey ? state.authorGroups.get(selectedAuthorKey) : null;
    if (author?.mesh) labels.push({ text: author.authorName, position: author.mesh.position, kind: 'author', active: true });
    state.focusPoemMeshes.forEach((mesh, index) => {
      const poem = mesh.userData.poem;
      if (index < 12 || poem.id === selectedId || poem.id === state.hoveredPoemId) {
        labels.push({ text: poem.title, position: mesh.position, kind: 'poem', active: poem.id === selectedId });
      }
    });
  }
  cloudLabelsEl.innerHTML = labels.map((label) => {
    const projected = label.position.clone().project(state.camera);
    const x = (projected.x * 0.5 + 0.5) * state.width;
    const y = (-projected.y * 0.5 + 0.5) * state.height;
    const visible = projected.z > -1 && projected.z < 1 && x > 25 && x < state.width - 25 && y > 20 && y < state.height - 35;
    return `<span class="cloud-label ${label.kind} ${label.active ? 'is-active' : ''}" style="left:${x}px;top:${y}px;opacity:${visible ? 1 : 0}">${label.text}</span>`;
  }).join('');
}

function updateOrbitalMotion(now, selectedAuthorKey) {
  const motion = reducedMotion.matches ? 0 : 1;
  const frameDelta = Math.min(50, Math.max(0, now - state.lastMotionAt));
  state.lastMotionAt = now;
  state.dynastyMarkers.forEach((dynasty) => {
    if (state.viewMode === 'overview') {
      const phase = now * dynasty.orbitSpeed + dynasty.phase;
      dynasty.center.set(
        dynasty.baseCenter.x + Math.cos(phase) * 9 * motion,
        dynasty.baseCenter.y + Math.sin(phase * 1.7) * 7 * motion,
        dynasty.baseCenter.z + Math.sin(phase) * 12 * motion,
      );
    }
    dynasty.mesh.position.copy(dynasty.center);
    if (dynasty.glow) dynasty.glow.position.copy(dynasty.center);
    if (dynasty.cloudGlow) dynasty.cloudGlow.position.copy(dynasty.center);
    const dust = state.dynastyDust.get(dynasty.dynasty);
    if (dust) {
      dust.position.copy(dynasty.center);
      if (motion) dust.rotation.y += frameDelta * dust.userData.speed;
    }
  });
  state.authorMarkers.forEach((author) => {
    const key = `${author.dynasty}:${author.authorName}`;
    const focused = key === selectedAuthorKey;
    const hovered = key === state.hoveredAuthorKey;
    const dynasty = state.dynastyGroups.get(author.dynasty);
    const previewVisible = state.viewMode === 'overview' && author.rank < OVERVIEW_PREVIEW_AUTHORS;
    const dynastyVisible = state.viewMode === 'dynasty' && author.dynasty === state.focusedDynasty && author.rank < MAX_VISIBLE_AUTHORS;
    const authorVisible = state.viewMode === 'author' && focused;
    if (!previewVisible && !dynastyVisible && !authorVisible) return;
    if (previewVisible) {
      const speedFactor = hovered ? 0.12 : motion;
      if (author.currentPreviewAngle === undefined) author.currentPreviewAngle = author.previewAngle;
      author.currentPreviewAngle += frameDelta * author.previewSpeed * speedFactor;
      const angle = author.currentPreviewAngle;
      const localZ = Math.sin(angle) * author.previewRadius * 0.72;
      author.center.set(
        dynasty.center.x + Math.cos(angle) * author.previewRadius,
        dynasty.center.y + Math.sin(author.previewTilt) * localZ + Math.sin(angle * 2) * 5,
        dynasty.center.z + Math.cos(author.previewTilt) * localZ,
      );
    } else if (dynastyVisible) {
      const offsetX = dynasty.center.x - dynasty.baseCenter.x;
      const offsetY = dynasty.center.y - dynasty.baseCenter.y;
      const offsetZ = dynasty.center.z - dynasty.baseCenter.z;
      const phase = now * author.orbitSpeed + author.phase;
      author.center.set(
        author.baseCenter.x + offsetX + Math.cos(phase) * 4 * motion,
        author.baseCenter.y + offsetY + Math.sin(phase * 1.8) * 5 * motion,
        author.baseCenter.z + offsetZ + Math.sin(phase) * 4 * motion,
      );
    }
    author.mesh.position.copy(author.center);
    if (author.glow) author.glow.position.copy(author.center);
    if (author.cloudGlow) author.cloudGlow.position.copy(author.center);
    author.poems.forEach((poem) => {
      const mesh = state.poemMeshById.get(poem.id);
      if (largeDatasetMode || !mesh) return;
      const poemFocused = focused || poem.id === state.hoveredPoemId;
      const poemSpeed = poemFocused ? 0 : motion;
      if (poem._currentOrbitAngle === undefined) poem._currentOrbitAngle = poem._phase;
      poem._currentOrbitAngle += frameDelta * poem._orbitSpeed * poemSpeed;
      const poemAngle = poem._currentOrbitAngle;
      const poemZ = Math.sin(poemAngle) * poem._orbitRadiusZ;
      mesh.position.set(
        author.center.x + Math.cos(poemAngle) * poem._orbitRadiusX,
        author.center.y + Math.sin(poem._orbitTilt) * poemZ,
        author.center.z + Math.cos(poem._orbitTilt) * poemZ,
      );
    });
  });
  state.relationLines.forEach((line) => {
    const mesh = state.poemMeshById.get(line.userData.poem.id);
    if (!mesh) return;
    const positions = line.geometry.attributes.position;
    positions.setXYZ(0, line.userData.author.center.x, line.userData.author.center.y, line.userData.author.center.z);
    positions.setXYZ(1, mesh.position.x, mesh.position.y, mesh.position.z);
    positions.needsUpdate = true;
  });
}

function init3D() {
  try {
    state.scene = new THREE.Scene();
    state.scene.background = null;
    state.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 7000);
    state.camera.position.set(0, 520, 1180);
    state.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, canvas: canvas3d });
    state.renderer.setClearColor(0x000000, 0);
    state.renderer.outputColorSpace = THREE.SRGBColorSpace;
    state.renderer.toneMapping = THREE.NoToneMapping;
    state.renderer.setPixelRatio(state.ratio);
    state.raycaster = new THREE.Raycaster();
    state.scene.add(new THREE.AmbientLight(0xffffff, 1.15), new THREE.PointLight(0x88c8ff, 2.4, 900));

    const starGeometry = new THREE.BufferGeometry();
    const starPositions = [];
    for (let i = 0; i < 7000; i++) starPositions.push((Math.random() - 0.5) * 5200, (Math.random() - 0.5) * 5200, (Math.random() - 0.5) * 5200);
    starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
    state.starField = new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: 0x8bbcff, size: 0.9, transparent: true, opacity: 0.32, depthWrite: false }));
    state.scene.add(state.starField);

    state.nodeGroup = new THREE.Group();
    state.scene.add(state.nodeGroup);
    state.focusGroup = new THREE.Group();
    state.nodeGroup.add(state.focusGroup);
    state.orbitLines = [];
    state.relationLines = [];
    state.decorativeLines = [];
    state.glows = [];
    state.poemMeshById.clear();
    state.focusPoemMeshById.clear();
    state.dynastyDust.clear();
    state.lastMotionAt = performance.now();
    computeHierarchy();
    createOrbitLine(new THREE.Vector3(0, 0, 0), 485, 385, 0x7587d8, 0.4);
    createDecorativeLines();

    const dynastyGeom = new THREE.SphereGeometry(14, 24, 24);
    const authorGeom = new THREE.SphereGeometry(6, 20, 20);
    const poemGeom = new THREE.SphereGeometry(1.15, 10, 10);

    state.dynastyMarkers.forEach((item) => {
      const mesh = new THREE.Mesh(
        dynastyGeom,
        new THREE.MeshBasicMaterial({ color: new THREE.Color(colorFromHue(item.hue, 82, 62)), transparent: true, opacity: 0.24, wireframe: true }),
      );
      mesh.position.copy(item.center);
      mesh.userData = { type: 'dynasty', dynasty: item.dynasty };
      item.mesh = mesh;
      item.glow = createGlow(colorFromHue(item.hue, 80, 64), 92, 0.16);
      item.glow.position.copy(item.center);
      item.cloudGlow = createGlow(colorFromHue(item.hue, 74, 58), 360, 0.055);
      item.cloudGlow.position.copy(item.center);
      state.nodeGroup.add(item.cloudGlow, item.glow, mesh);
      createOrbitLine(item.center, 148, 104, new THREE.Color(colorFromHue(item.hue, 66, 60)), item.phase);
    });

    state.authorMarkers.forEach((item) => {
      const mesh = new THREE.Mesh(
        authorGeom,
        new THREE.MeshBasicMaterial({ color: new THREE.Color(colorFromHue(item.hue, 86, 66)), transparent: true, opacity: 0.96 }),
      );
      mesh.position.copy(item.center);
      mesh.userData = { type: 'author', dynasty: item.dynasty, authorName: item.authorName };
      item.mesh = mesh;
      item.glow = createGlow(colorFromHue(item.hue, 84, 66), 130, 0.08);
      item.glow.position.copy(item.center);
      item.cloudGlow = createGlow(colorFromHue(item.hue, 80, 58), 220, 0.045);
      item.cloudGlow.position.copy(item.center);
      state.nodeGroup.add(item.cloudGlow, item.glow, mesh);
    });

    createDynastyDust();

    state.poemPoints = null;
    if (!largeDatasetMode) {
      poems.forEach((poem) => {
        const mesh = new THREE.Mesh(
          poemGeom,
          new THREE.MeshBasicMaterial({ color: new THREE.Color(colorFromHue(poem._hue || 210, 84, 68)), transparent: true, opacity: 0.92 }),
        );
        mesh.position.copy(poem._position);
        mesh.userData = { type: 'poem', id: poem.id, poem };
        state.nodeGroup.add(mesh);
        state.poemMeshes.push(mesh);
        state.poemMeshById.set(poem.id, mesh);
      });
    }
    createRelationLines();

    focusHome();
    setDebug(`3D 星系：${state.dynastyMarkers.length} 朝代 / ${state.authorMarkers.length} 位诗人`);
    return true;
  } catch (error) {
    setDebug(`3D 初始化失败，降级 2D：${error.message}`);
    state.mode = '2d';
    return false;
  }
}

function render3D() {
  if (!state.renderer) return;
  const selected = poems.find((item) => item.id === selectedId);
  const selectedAuthorKey = state.trackedAuthorKey || (selected ? `${selected.dynasty}:${selected.authorName}` : null);
  const selectedDynasty = state.focusedDynasty || selected?.dynasty || null;
  const visibleIds = state.visibleIds;

  state.poemMeshes.forEach((mesh) => {
    mesh.visible = false;
  });

  state.authorMarkers.forEach((item) => {
    if (!item.mesh) return;
    const key = `${item.dynasty}:${item.authorName}`;
    const active = key === selectedAuthorKey;
    const hovered = state.hoveredAuthorKey === key;
    const hasVisiblePoems = state.visibleAuthorKeys.has(key);
    const visibleInOverview = state.viewMode === 'overview' && item.rank < OVERVIEW_PREVIEW_AUTHORS && hasVisiblePoems;
    const visibleInDynasty = state.viewMode === 'dynasty' && item.dynasty === selectedDynasty && item.rank < MAX_VISIBLE_AUTHORS && hasVisiblePoems;
    const visibleInAuthor = state.viewMode === 'author' && active;
    const visible = visibleInOverview || visibleInDynasty || visibleInAuthor;
    item.mesh.visible = visible;
    if (item.glow) item.glow.visible = visible;
    if (item.cloudGlow) item.cloudGlow.visible = visible;
    if (!visible) return;
    const pulse = hovered ? 1.08 + Math.sin(performance.now() * 0.006) * 0.06 : 1;
    item.mesh.material.opacity = active || hovered ? 1 : visibleInOverview ? 0.72 : 0.82;
    const workScale = 0.92 + Math.min(0.72, Math.log1p(item.poems.length) / 9);
    const overviewScale = 0.42 + Math.min(0.44, Math.log1p(item.poems.length) / 11);
    item.mesh.scale.setScalar((active ? 2.4 : hovered ? 1.7 : visibleInOverview ? overviewScale : workScale) * pulse);
    if (item.glow) {
      item.glow.material.opacity = active ? 0.5 : hovered ? 0.38 : visibleInOverview ? 0.085 : 0.13;
      item.glow.scale.setScalar((active ? 175 : hovered ? 150 : visibleInOverview ? 64 : 120) * pulse);
    }
    if (item.cloudGlow) {
      item.cloudGlow.material.opacity = active ? 0.2 : hovered ? 0.14 : visibleInOverview ? 0.018 : 0.045;
      item.cloudGlow.scale.setScalar((active ? 320 : visibleInOverview ? 120 : 210) * pulse);
    }
  });

  state.dynastyMarkers.forEach((item) => {
    if (!item.mesh) return;
    const active = item.dynasty === selectedDynasty;
    item.mesh.visible = state.viewMode === 'overview' || (state.viewMode === 'dynasty' && active);
    item.glow.visible = item.mesh.visible;
    if (item.cloudGlow) item.cloudGlow.visible = item.mesh.visible;
    const hovered = item.dynasty === state.hoveredDynasty;
    const breath = reducedMotion.matches ? 1 : 1 + Math.sin(performance.now() * 0.0012 + item.phase) * 0.045;
    item.mesh.material.opacity = active ? 0.46 : hovered ? 0.5 : 0.34;
    item.mesh.scale.setScalar((active ? 1.55 : hovered ? 1.45 : 1.22) * (item.visualScale || 1) * breath);
    if (item.glow) {
      item.glow.material.opacity = active ? 0.28 : hovered ? 0.25 : 0.14;
      item.glow.scale.setScalar((active ? 112 : hovered ? 108 : 92) * (item.visualScale || 1) * breath);
    }
    if (item.cloudGlow) {
      item.cloudGlow.material.opacity = active ? 0.1 : hovered ? 0.105 : 0.065;
      item.cloudGlow.scale.setScalar((active ? 430 : hovered ? 420 : 360) * (item.visualScale || 1) * breath);
    }
  });

  state.dynastyDust.forEach((cloud, dynasty) => {
    cloud.visible = state.viewMode !== 'author' || dynasty === selectedDynasty;
    const dustPulse = reducedMotion.matches ? 0 : Math.sin(performance.now() * 0.0008 + cloud.userData.phase) * 0.045;
    cloud.material.opacity = state.viewMode === 'overview' ? 0.32 + dustPulse : dynasty === selectedDynasty ? (state.viewMode === 'dynasty' ? 0.31 : 0.025) : 0.012;
    cloud.material.size = state.viewMode === 'dynasty' && dynasty === selectedDynasty ? 2.75 : 2.4;
  });

  state.focusPoemMeshes.forEach((mesh) => {
    const poem = mesh.userData.poem;
    const selectedPoint = poem.id === selectedId;
    const hoveredPoint = poem.id === state.hoveredPoemId;
    mesh.visible = state.viewMode === 'author' && visibleIds.has(poem.id);
    mesh.material.opacity = selectedPoint || hoveredPoint ? 1 : 0.92;
    mesh.scale.setScalar(selectedPoint ? 2.2 : hoveredPoint ? 1.75 : 1 + Math.min(0.55, (poem.importance || 0) * 0.22));
  });
  if (state.focusAmbientPoints) state.focusAmbientPoints.visible = state.viewMode === 'author';
  state.focusOrbitLines.forEach((line) => { line.visible = state.viewMode === 'author'; });

  state.relationLines.forEach((line) => {
    line.visible = false;
    const poem = line.userData.poem;
    const authorKey = `${poem.dynasty}:${poem.authorName}`;
    const related = authorKey === selectedAuthorKey;
    const hovered = poem.id === state.hoveredPoemId;
    line.material.opacity = visibleIds.has(poem.id) ? (hovered ? 0.22 : related ? 0.34 : selectedId ? 0.012 : 0.035) : 0.005;
  });
  state.orbitLines.forEach((line, index) => {
    const selectedIndex = selectedDynasty ? state.dynastyGroups.get(selectedDynasty)?.index + 1 : -1;
    line.visible = state.viewMode === 'overview' || (state.viewMode === 'dynasty' && index === selectedIndex);
    line.material.opacity = state.viewMode === 'overview' ? (index === 0 ? 0.1 : 0.075) : 0.11;
  });
  renderLabels(selectedAuthorKey, selectedDynasty);
}

function focusOnPoem(poem) {
  const authorKey = `${poem.dynasty}:${poem.authorName}`;
  const authorGroup = state.authorGroups.get(authorKey);
  if (!authorGroup) return;
  activeDynasty = poem.dynasty;
  activeAuthor = poem.authorName;
  setFocusMode(authorGroup);
  renderFilters();
  applyFilters();
}

function focusHome() {
  setOverviewMode();
}

function animate3D(now = performance.now()) {
  state.frame = requestAnimationFrame(animate3D);
  const selected = poems.find((item) => item.id === selectedId);
  const selectedAuthorKey = selected ? `${selected.dynasty}:${selected.authorName}` : null;
  const motion = reducedMotion.matches || selectedId || state.drag.active ? 0 : 1;
  if (motion) {
    state.starField.rotation.y = Math.sin(now * 0.000012) * 0.025;
    state.starField.rotation.x = Math.cos(now * 0.000009) * 0.012;
    state.decorativeLines.forEach((line) => {
      line.rotation.y += line.userData.speed;
      line.material.opacity = 0.045 + Math.sin(now * 0.00035 + line.userData.phase) * 0.016;
    });
    if (state.viewMode === 'overview' && !state.drag.active) {
      state.orbit.theta += 0.000035;
      updateCameraFromOrbit();
    }
  }
  updateOrbitalMotion(now, selectedAuthorKey);
  if (state.trackedAuthorKey) {
    const trackedAuthor = state.authorGroups.get(state.trackedAuthorKey);
    if (trackedAuthor) {
      state.orbitTarget.copy(trackedAuthor.center);
      updateCameraFromOrbit();
    }
  }
  state.camera.position.lerp(state.cameraTarget, 0.06);
  state.cameraLookTarget.lerp(state.orbitTarget, state.viewMode === 'author' ? 0.08 : 0.035);
  state.camera.lookAt(state.cameraLookTarget);
  render3D();
  state.renderer.render(state.scene, state.camera);
  if (state.viewMode === 'overview') setDebug(`宇宙总览 · ${state.dynastyMarkers.length} 个朝代星系`);
  else if (state.viewMode === 'dynasty') setDebug(`${state.focusedDynasty} · ${state.authorMarkers.filter((item) => item.dynasty === state.focusedDynasty).length} 位诗人`);
  else setDebug(`${state.authorGroups.get(state.trackedAuthorKey)?.authorName || '诗人'} · ${state.focusPoemMeshes.length} 首可探索诗作`);
}

function hitTest3D(clientX, clientY) {
  const rect = canvas3d.getBoundingClientRect();
  state.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  state.pointer.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
  state.raycaster.setFromCamera(state.pointer, state.camera);
  let targets = [];
  if (state.viewMode === 'overview') targets = state.dynastyMarkers.filter((item) => item.mesh?.visible).map((item) => item.mesh);
  if (state.viewMode === 'dynasty') targets = state.authorMarkers.filter((item) => item.mesh?.visible).map((item) => item.mesh);
  if (state.viewMode === 'author') targets = state.focusPoemMeshes.filter((mesh) => mesh.visible);
  const hits = state.raycaster.intersectObjects(targets, false);
  if (!hits.length) return null;
  const userData = hits[0].object.userData;
  if (userData.type === 'poem-points') return null;
  if (userData.type === 'poem') return { type: 'poem', poem: userData.poem };
  if (userData.type === 'author') return { type: 'author', dynasty: userData.dynasty, authorName: userData.authorName };
  if (userData.type === 'dynasty') return { type: 'dynasty', dynasty: userData.dynasty };
  return null;
}

async function dataGet(path) {
  const response = await fetch(new URL(path, DATA_BASE));
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function loadWorkDetail(work) {
  if (!work.bucket) throw new Error('诗词详情缺少数据分区');
  let bucket = detailBucketCache.get(work.bucket);
  if (!bucket) {
    bucket = await dataGet(`works/${work.bucket}.json`);
    detailBucketCache.set(work.bucket, bucket);
  }
  const detail = bucket[work.id];
  if (!detail) throw new Error('找不到这首诗的详情');
  return detail;
}

async function loadSearchCorpus() {
  if (!searchCorpusPromise) {
    const buckets = Array.from({ length: SEARCH_BUCKET_COUNT }, (_, index) => index.toString(16).padStart(2, '0'));
    searchCorpusPromise = Promise.all(buckets.map((bucket) => dataGet(`search/${bucket}.json`)))
      .then((parts) => parts.flat());
  }
  return searchCorpusPromise;
}

async function loadData() {
  try {
    const [manifestData, dynastyData, authorData, worksData] = await Promise.all([
      dataGet('manifest.json'),
      dataGet('dynasties.json'),
      dataGet('authors.index.json'),
      dataGet('works.index.json'),
    ]);
    manifest = manifestData;
    dynasties = dynastyData;
    authors = authorData;
    poems = worksData.map((item) => ({
      id: item.id,
      title: item.title,
      authorName: item.author_name || item.authorName,
      dynasty: item.dynasty,
      meter: item.meter || '其他',
      rhythmic: item.rhythmic || '',
      lines: Array.isArray(item.lines) ? item.lines : [],
      tags: Array.isArray(item.tags) ? item.tags : [],
      content: item.content || '',
      normalizedContent: normalizeText(item.content || item.excerpt || ''),
      excerpt: item.excerpt || (Array.isArray(item.lines) && item.lines.length ? item.lines[0] : ''),
      importance: Number(item.importance) || 0,
      bucket: item.bucket,
    }));
    filteredPoems = poems.slice();
    updateVisibilityIndex();
    renderStats();
    renderFilters();
    renderResults();
    if (init3D()) {
      resize();
      setOverviewMode();
      animate3D();
    }
    window.__POETS_DEBUG__ = { poems, authors, dynasties, mode: 'static-github-pages' };
  } catch (error) {
    console.error('[Poets Cloud] loadData failed', error);
    setDebug(`加载失败：${error.message}`);
    detailEl.textContent = `加载失败：${error.message}`;
  }
}

searchInput.addEventListener('input', async (event) => {
  searchTerm = event.target.value;
  const version = ++searchRequestVersion;
  if (!searchTerm.trim()) {
    searchMatchIds = null;
    applyFilters();
    return;
  }
  const term = normalizeText(searchTerm);
  searchMatchIds = new Set(poems
    .filter((poem) => normalizeText(`${poem.title}${poem.authorName}${poem.dynasty}${poem.meter}${poem.excerpt}`).includes(term))
    .map((poem) => poem.id));
  applyFilters();
  if (term.length < 2) return;
  try {
    setDebug('正在检索完整诗文…');
    const corpus = await loadSearchCorpus();
    if (version !== searchRequestVersion) return;
    searchMatchIds = new Set(corpus.filter((item) => item.text.includes(term)).map((item) => item.id));
    applyFilters();
  } catch (error) {
    setDebug(`搜索失败：${error.message}`);
  }
});
clearSelectionBtn.addEventListener('click', clearSelection);
resetViewBtn.addEventListener('click', resetView);
if (toggleFiltersBtn && controlPanelEl) {
  toggleFiltersBtn.addEventListener('click', () => {
    const collapsed = controlPanelEl.classList.toggle('filters-collapsed');
    toggleFiltersBtn.textContent = collapsed ? '展开筛选' : '收起筛选';
    toggleFiltersBtn.setAttribute('aria-expanded', String(!collapsed));
  });
}

canvas3d.addEventListener('pointermove', (event) => {
  if (!state.renderer || state.drag.active) return;
  const hit = hitTest3D(event.clientX, event.clientY);
  state.hoveredPoemId = null;
  state.hoveredAuthorKey = null;
  state.hoveredDynasty = null;
  if (hit) {
    if (hit.type === 'poem') {
      state.hoveredPoemId = hit.poem.id;
      canvas3d.style.cursor = 'pointer';
      if (cloudTooltipEl) {
        cloudTooltipEl.innerHTML = `<div class="tooltip-title">${hit.poem.title}</div><div class="tooltip-meta">${hit.poem.authorName} · ${hit.poem.meter}</div>`;
        cloudTooltipEl.classList.add('visible');
      }
    } else if (hit.type === 'author') {
      state.hoveredAuthorKey = `${hit.dynasty}:${hit.authorName}`;
      canvas3d.style.cursor = 'pointer';
      if (cloudTooltipEl) {
        const authorInfo = state.authorGroups.get(state.hoveredAuthorKey);
        cloudTooltipEl.innerHTML = `<div class="tooltip-title">${hit.authorName}</div><div class="tooltip-meta">${hit.dynasty} · ${authorInfo ? authorInfo.poems.length : 0} 首诗</div>`;
        cloudTooltipEl.classList.add('visible');
        const rect = cloudEl.getBoundingClientRect();
        cloudTooltipEl.style.left = `${event.clientX - rect.left + 12}px`;
        cloudTooltipEl.style.top = `${event.clientY - rect.top + 12}px`;
      }
    } else if (hit.type === 'dynasty') {
      state.hoveredDynasty = hit.dynasty;
      canvas3d.style.cursor = 'pointer';
      if (cloudTooltipEl) {
        const info = dynasties.find((item) => item.name === hit.dynasty);
        cloudTooltipEl.innerHTML = `<div class="tooltip-title">${hit.dynasty}代</div><div class="tooltip-meta">${info?.workCount?.toLocaleString() || '—'} 首诗 · ${info?.authorCount?.toLocaleString() || '—'} 位诗人</div>`;
        cloudTooltipEl.classList.add('visible');
      }
    }
    if (cloudTooltipEl) {
      const rect = cloudEl.getBoundingClientRect();
      cloudTooltipEl.style.left = `${event.clientX - rect.left + 12}px`;
      cloudTooltipEl.style.top = `${event.clientY - rect.top + 12}px`;
    }
  } else {
    canvas3d.style.cursor = 'grab';
    if (cloudTooltipEl) cloudTooltipEl.classList.remove('visible');
  }
  state.pointerClient = { x: event.clientX, y: event.clientY };
});
canvas3d.addEventListener('pointerleave', () => {
  state.hoveredPoemId = null;
  state.hoveredAuthorKey = null;
  state.hoveredDynasty = null;
  if (cloudTooltipEl) cloudTooltipEl.classList.remove('visible');
});
canvas3d.addEventListener('contextmenu', (event) => event.preventDefault());
canvas3d.addEventListener('auxclick', (event) => event.preventDefault());
canvas3d.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  state.drag.active = true;
  state.drag.moved = false;
  state.drag.suppressClick = false;
  state.drag.mode = (event.buttons & 6) !== 0 || event.shiftKey ? 'pan' : 'rotate';
  state.drag.x = event.clientX;
  state.drag.y = event.clientY;
  canvas3d.style.cursor = state.drag.mode === 'pan' ? 'move' : 'grabbing';
  canvas3d.setPointerCapture(event.pointerId);
});
canvas3d.addEventListener('pointermove', (event) => {
  if (!state.drag.active || !state.renderer) return;
  event.preventDefault();
  const dx = event.clientX - state.drag.x;
  const dy = event.clientY - state.drag.y;
  if (Math.hypot(dx, dy) >= 3) state.drag.moved = true;
  state.drag.x = event.clientX;
  state.drag.y = event.clientY;
  if (!state.drag.moved) return;
  if (state.drag.mode === 'pan') {
    const distance = state.camera.position.distanceTo(state.orbitTarget);
    const worldPerPixel = (2 * distance * Math.tan(THREE.MathUtils.degToRad(state.camera.fov * 0.5))) / Math.max(1, state.height);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(state.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(state.camera.quaternion);
    const offset = right.multiplyScalar(-dx * worldPerPixel).add(up.multiplyScalar(dy * worldPerPixel));
    state.orbitTarget.add(offset);
    state.cameraLookTarget.add(offset);
  } else {
    state.orbit.theta -= dx * 0.0032;
    state.orbit.phi += dy * 0.0032;
    stabilizeOrbit();
  }
  updateCameraFromOrbit();
});
function finishCameraDrag(event) {
  if (!state.drag.active) return;
  state.drag.active = false;
  state.drag.suppressClick = state.drag.moved;
  if (event && canvas3d.hasPointerCapture(event.pointerId)) canvas3d.releasePointerCapture(event.pointerId);
  canvas3d.style.cursor = 'grab';
}
canvas3d.addEventListener('pointerup', finishCameraDrag);
canvas3d.addEventListener('pointercancel', finishCameraDrag);
window.addEventListener('wheel', (event) => {
  if (!state.renderer || event.target !== canvas3d) return;
  event.preventDefault();
  state.orbit.radius += event.deltaY * 3;
  stabilizeOrbit();
  updateCameraFromOrbit();
}, { passive: false });
window.addEventListener('keydown', (event) => {
  if (!state.renderer) return;
  const step = 0.06;
  if (event.key === 'ArrowLeft') state.orbit.theta -= step;
  if (event.key === 'ArrowRight') state.orbit.theta += step;
  if (event.key === 'ArrowUp') state.orbit.phi -= step;
  if (event.key === 'ArrowDown') state.orbit.phi += step;
  if (event.key === '+' || event.key === '=') state.orbit.radius -= 10;
  if (event.key === '-' || event.key === '_') state.orbit.radius += 10;
  stabilizeOrbit();
  updateCameraFromOrbit();
});
window.addEventListener('resize', resize);
window.addEventListener('click', async (event) => {
  if (event.target !== canvas3d) return;
  if (state.drag.suppressClick) {
    state.drag.suppressClick = false;
    return;
  }
  const hit = hitTest3D(event.clientX, event.clientY);
  if (hit && hit.type === 'poem') {
    await selectPoem(hit.poem.id);
  } else if (hit && hit.type === 'author') {
    const authorGroup = state.authorGroups.get(`${hit.dynasty}:${hit.authorName}`);
    if (authorGroup) {
      activeDynasty = authorGroup.dynasty;
      activeAuthor = authorGroup.authorName;
      setFocusMode(authorGroup);
      renderFilters();
      applyFilters();
    }
  } else if (hit && hit.type === 'dynasty') {
    activeDynasty = hit.dynasty;
    activeAuthor = '全部';
    setDynastyMode(hit.dynasty);
    renderFilters();
    applyFilters();
  }
});

if (levelNavEl) {
  levelNavEl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-level]');
    if (!button || button.disabled) return;
    if (button.dataset.level === 'overview') {
      activeDynasty = '全部';
      activeAuthor = '全部';
      setOverviewMode();
    } else if (button.dataset.level === 'dynasty' && state.focusedDynasty) {
      activeDynasty = state.focusedDynasty;
      activeAuthor = '全部';
      setDynastyMode(state.focusedDynasty);
    }
    renderFilters();
    applyFilters();
  });
}

resize();
loadData();
