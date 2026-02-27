import { create } from "zustand";
import type {
  AppPage,
  AppSettings,
  CachePathInfo,
  CacheResource,
  FilterCategory,
  RecoveryOptions,
  RecoveryProgress,
  ScannerStep,
  SortOrder,
} from "@/types";

interface AppStore {
  currentPage: AppPage;
  setCurrentPage: (page: AppPage) => void;

  scannerStep: ScannerStep;
  setScannerStep: (step: ScannerStep) => void;

  cachePaths: CachePathInfo[];
  setCachePaths: (paths: CachePathInfo[]) => void;
  selectedPaths: string[];
  togglePathSelection: (path: string) => void;
  setSelectedPaths: (paths: string[]) => void;
  removeFromCachePaths: (path: string) => void;

  scanProgress: { current: number; total: number; currentFile: string; phase: string };
  setScanProgress: (progress: { current: number; total: number; currentFile: string; phase: string }) => void;

  resources: CacheResource[];
  setResources: (resources: CacheResource[]) => void;
  toggleResourceSelection: (id: string) => void;
  selectAllResources: () => void;
  deselectAllResources: () => void;
  selectResourcesByCategory: (category: FilterCategory) => void;

  filterCategory: FilterCategory;
  setFilterCategory: (category: FilterCategory) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;


  sortOrder: SortOrder;
  setSortOrder: (order: SortOrder) => void;
  previewResource: CacheResource | null;
  setPreviewResource: (resource: CacheResource | null) => void;

  recoveryOptions: RecoveryOptions;
  setRecoveryOptions: (options: Partial<RecoveryOptions>) => void;

  recoveryProgress: RecoveryProgress | null;
  setRecoveryProgress: (progress: RecoveryProgress | null) => void;

  settings: AppSettings;
  setSettings: (settings: Partial<AppSettings>) => void;

  isScanning: boolean;
  setIsScanning: (scanning: boolean) => void;
  isRecovering: boolean;
  setIsRecovering: (recovering: boolean) => void;

  resetScanner: () => void;
}

export const useAppStore = create<AppStore>((set) => ({
  currentPage: "scanner",
  setCurrentPage: (page) => set({ currentPage: page }),

  scannerStep: "select",
  setScannerStep: (step) => set({ scannerStep: step }),

  cachePaths: [],
  setCachePaths: (paths) => set({ cachePaths: paths }),
  selectedPaths: [],
  togglePathSelection: (path) => set((state) => ({
    selectedPaths: state.selectedPaths.includes(path)
      ? state.selectedPaths.filter((p) => p !== path)
      : [...state.selectedPaths, path],
  })),
  setSelectedPaths: (paths) => set({ selectedPaths: paths }),
  removeFromCachePaths: (path) => set((state) => ({
    cachePaths: state.cachePaths.filter((p) => p.path !== path),
    selectedPaths: state.selectedPaths.filter((p) => p !== path),
  })),

  scanProgress: { current: 0, total: 0, currentFile: "", phase: "" },
  setScanProgress: (progress) => set({ scanProgress: progress }),

  resources: [],
  setResources: (resources) => set({ resources }),
  toggleResourceSelection: (id) => set((state) => ({
    resources: state.resources.map((r) =>
      r.id === id ? { ...r, selected: !r.selected } : r,
    ),
  })),
  selectAllResources: () => set((state) => ({
    resources: state.resources.map((r) => ({ ...r, selected: true })),
  })),
  deselectAllResources: () => set((state) => ({
    resources: state.resources.map((r) => ({ ...r, selected: false })),
  })),
  selectResourcesByCategory: (category) => set((state) => ({
    resources: state.resources.map((r) => ({
      ...r,
      selected: category === "all" ? true
        : category === "images" ? r.mediaCategory === "image"
        : category === "videos" ? r.mediaCategory === "video"
        : category === "audio" ? r.mediaCategory === "audio"
        : r.mediaCategory === "other",
    })),
  })),

  filterCategory: "all",
  setFilterCategory: (category) => set({ filterCategory: category }),
  searchQuery: "",
  setSearchQuery: (query) => set({ searchQuery: query }),

  sortOrder: "newest" as SortOrder,
  setSortOrder: (order) => set({ sortOrder: order }),
  previewResource: null,
  setPreviewResource: (resource) => set({ previewResource: resource }),

  recoveryOptions: {
    outputFolder: "",
    convertWebmToMp4: true,
    organizeByType: true,
    organizeByDate: false,
    generateThumbnails: true,
    convertGifToMp4: false,
    concatenateVideos: false,
  },
  setRecoveryOptions: (options) => set((state) => ({
    recoveryOptions: { ...state.recoveryOptions, ...options },
  })),

  recoveryProgress: null,
  setRecoveryProgress: (progress) => set({ recoveryProgress: progress }),

  settings: {
    maxThreads: 4,
    outputNamingTemplate: "{type}_{index}",
    autoOpenOutput: true,
    defaultOutputFolder: "",
    theme: "dark",
  },
  setSettings: (settings) => set((state) => ({
    settings: { ...state.settings, ...settings },
  })),

  isScanning: false,
  setIsScanning: (scanning) => set({ isScanning: scanning }),
  isRecovering: false,
  setIsRecovering: (recovering) => set({ isRecovering: recovering }),

  resetScanner: () => set({
    scannerStep: "select" as ScannerStep,
    isScanning: false,
    isRecovering: false,
    scanProgress: { current: 0, total: 0, currentFile: "", phase: "" },
    recoveryProgress: null,
    resources: [],
    selectedPaths: [],
    filterCategory: "all" as FilterCategory,
    searchQuery: "",
    previewResource: null,
  }),
}));
