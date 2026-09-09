import { create } from 'zustand';
import type { Author, Dynasty, Manifest, WorkDetail, WorkIndex } from './types';

type Filters = { query: string; dynasty: string; meter: string; author: string };
type AppState = {
  manifest: Manifest | null;
  authors: Author[];
  dynasties: Dynasty[];
  works: WorkIndex[];
  filteredWorks: WorkIndex[];
  selectedWork: WorkDetail | null;
  focusedAuthor: string | null;
  filters: Filters;
  isLoading: boolean;
  error: string | null;
  setData: (data: Pick<AppState, 'manifest' | 'authors' | 'dynasties' | 'works'>) => void;
  setFilters: (filters: Partial<Filters>) => void;
  selectWork: (work: WorkDetail | null) => void;
  focusAuthor: (author: string | null) => void;
};

const initialFilters: Filters = { query: '', dynasty: '全部', meter: '全部', author: '全部' };

export const useAppStore = create<AppState>((set) => ({
  manifest: null,
  authors: [],
  dynasties: [],
  works: [],
  filteredWorks: [],
  selectedWork: null,
  focusedAuthor: null,
  filters: initialFilters,
  isLoading: true,
  error: null,
  setData: (data) => set({ ...data, filteredWorks: data.works, isLoading: false }),
  setFilters: (patch) => set((state) => {
    const filters = { ...state.filters, ...patch };
    const query = filters.query.trim().toLowerCase().replace(/\s+/g, '');
    const filteredWorks = state.works.filter((work) => {
      const textMatch = !query || `${work.title}${work.authorName}${work.dynasty}${work.meter}${work.excerpt}`.toLowerCase().replace(/\s+/g, '').includes(query);
      return textMatch && (filters.dynasty === '全部' || work.dynasty === filters.dynasty) && (filters.meter === '全部' || work.meter === filters.meter) && (filters.author === '全部' || work.authorName === filters.author);
    });
    return { filters, filteredWorks };
  }),
  selectWork: (selectedWork) => set({ selectedWork }),
  focusAuthor: (focusedAuthor) => set({ focusedAuthor }),
}));
