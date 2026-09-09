import { useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Stars, Text } from '@react-three/drei';
import { getAuthors, getDynasties, getManifest, getWorkDetail, getWorkIndex } from './api';
import { useAppStore } from './store';
import type { WorkIndex } from './types';
import './styles.css';

function Cloud({ works, onSelect }: { works: WorkIndex[]; onSelect: (work: WorkIndex) => void }) {
  const visible = works.slice(0, 4200);
  return <>
    <Stars radius={1800} depth={600} count={2600} factor={2.1} saturation={0.15} fade speed={0.25} />
    {visible.map((work) => <mesh key={work.id} position={work.position} onClick={(event) => { event.stopPropagation(); onSelect(work); }}>
      <sphereGeometry args={[Math.max(0.7, work.importance * 2.5), 8, 8]} />
      <meshBasicMaterial color={work.meter === '词' ? '#f5c96b' : work.meter === '七绝' ? '#78b9ff' : '#b79bff'} transparent opacity={0.82} />
    </mesh>)}
  </>;
}

function App() {
  const { manifest, authors, dynasties, works, filteredWorks, selectedWork, focusedAuthor, filters, isLoading, error, setData, setFilters, selectWork, focusAuthor } = useAppStore();
  const [showGuide, setShowGuide] = useState(() => localStorage.getItem('poetry-guide-seen') !== '1');
  const [isPanelOpen, setPanelOpen] = useState(false);
  const [isFilterOpen, setFilterOpen] = useState(false);
  const meters = useMemo(() => ['全部', ...new Set(works.map((work) => work.meter))], [works]);

  useEffect(() => {
    Promise.all([getManifest(), getAuthors(), getDynasties(), getWorkIndex()])
      .then(([nextManifest, nextAuthors, nextDynasties, nextWorks]) => setData({ manifest: nextManifest, authors: nextAuthors, dynasties: nextDynasties, works: nextWorks }))
      .catch((cause: Error) => useAppStore.setState({ isLoading: false, error: cause.message }));
  }, [setData]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '/' && document.activeElement?.tagName !== 'INPUT') { event.preventDefault(); document.querySelector<HTMLInputElement>('#search')?.focus(); }
      if (event.key.toLowerCase() === 'h' && document.activeElement?.tagName !== 'INPUT') document.body.classList.toggle('ui-hidden');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const chooseWork = async (work: WorkIndex) => {
    try { selectWork(await getWorkDetail(work)); setPanelOpen(true); focusAuthor(work.authorName); } catch (cause) { useAppStore.setState({ error: (cause as Error).message }); }
  };

  return <main className="app">
    <Canvas camera={{ position: [0, 300, 820], fov: 55 }} dpr={[1, 1.75]} gl={{ antialias: true }}>
      <color attach="background" args={['#07080f']} />
      <fog attach="fog" args={['#07080f', 500, 1900]} />
      <ambientLight intensity={0.6} />
      <Cloud works={focusedAuthor ? filteredWorks.filter((work) => work.authorName === focusedAuthor) : filteredWorks} onSelect={chooseWork} />
      <OrbitControls enablePan={false} minDistance={180} maxDistance={1500} enableDamping dampingFactor={0.07} />
    </Canvas>

    <section className="hud">
      <div className="brand"><span className="eyebrow">POETRY CLOUD</span><h1>诗云</h1><p>在星群之间，遇见一首诗</p></div>
      <div className="search-box"><input id="search" value={filters.query} onChange={(event) => setFilters({ query: event.target.value })} placeholder="搜索诗名、诗人或诗句" aria-label="搜索诗名、诗人或诗句" /><button type="button" onClick={() => setFilterOpen((open) => !open)}>筛选</button></div>
      <div className="status">{isLoading ? '正在点亮诗云…' : `${filteredWorks.length.toLocaleString()} 首可探索 · ${manifest?.authorCount.toLocaleString() ?? authors.length.toLocaleString()} 位诗人`}</div>
    </section>

    {isFilterOpen && <section className="filter-panel glass"><label>朝代<select value={filters.dynasty} onChange={(event) => setFilters({ dynasty: event.target.value })}><option>全部</option>{dynasties.map((item) => <option key={item.id}>{item.name}</option>)}</select></label><label>格律<select value={filters.meter} onChange={(event) => setFilters({ meter: event.target.value })}>{meters.map((item) => <option key={item}>{item}</option>)}</select></label><label>诗人<select value={filters.author} onChange={(event) => setFilters({ author: event.target.value })}><option>全部</option>{authors.slice(0, 300).map((item) => <option key={item.id}>{item.name}</option>)}</select></label><button type="button" onClick={() => { setFilters({ query: '', dynasty: '全部', meter: '全部', author: '全部' }); focusAuthor(null); }}>重置</button></section>}

    <div className="bottom-bar"><button type="button" onClick={() => focusAuthor(null)}>回到全景</button><button type="button" onClick={() => setPanelOpen(true)}>浏览结果 ({filteredWorks.length.toLocaleString()})</button><span>拖拽漫游 · 滚轮缩放 · 点击诗星读诗 · 按 H 隐藏界面</span></div>

    {isPanelOpen && <aside className="work-panel glass"><button className="close" type="button" onClick={() => setPanelOpen(false)}>×</button>{selectedWork ? <><div className="work-kicker">{selectedWork.dynasty} · {selectedWork.meter}</div><h2>{selectedWork.title}</h2><div className="work-author">{selectedWork.authorName}</div><div className="work-lines">{selectedWork.lines.map((line, index) => <div key={`${line}-${index}`}>{line}</div>)}</div><div className="tags">{selectedWork.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><button className="secondary" type="button" onClick={() => focusAuthor(selectedWork.authorName)}>探索同一星团</button></> : <div className="result-drawer"><h2>探索诗云</h2>{filteredWorks.slice(0, 30).map((work) => <button className="result" type="button" key={work.id} onClick={() => chooseWork(work)}><strong>{work.title}</strong><span>{work.authorName} · {work.dynasty}</span></button>)}</div>}</aside>}

    {showGuide && <div className="guide-backdrop"><section className="guide glass"><div className="eyebrow">WELCOME TO POETRY CLOUD</div><h2>从虚空里，捞起一首诗</h2><p>这是一个可以漫游的诗词星图。每个星团属于一位诗人，点击诗星即可读诗。</p><div className="guide-actions"><button type="button" onClick={() => { localStorage.setItem('poetry-guide-seen', '1'); setShowGuide(false); }}>开始漫游</button><button className="ghost" type="button" onClick={() => setShowGuide(false)}>跳过提示</button></div></section></div>}
    {(error || !isLoading && !works.length) && <div className="error glass">{error ?? '没有加载到数据，请检查数据构建结果。'}</div>}
  </main>;
}

export default App;
