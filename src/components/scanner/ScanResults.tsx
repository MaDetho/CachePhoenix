import { useMemo, useCallback, useRef, memo, useState, useLayoutEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAppStore } from '@/store';
import { formatBytes, formatDuration } from '@/lib/utils';

import {
  Search,
  Film,
  Image as ImageIcon,
  Music,
  File,
  ChevronRight,
  Check,
  Filter,
  Maximize2,
  ArrowUp,
  ArrowDown,
  Clock,
  RotateCcw,
} from 'lucide-react';
import type { CacheResource, FilterCategory, MediaCategory } from '@/types';
import { cancelCurrentScan } from '@/lib/scanService';

function formatDateTime(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getIconForCategory(category: MediaCategory): React.ElementType {
  switch (category) {
    case 'image': return ImageIcon;
    case 'video': return Film;
    case 'audio': return Music;
    default: return File;
  }
}

const CATEGORY_TO_MEDIA: Record<FilterCategory, MediaCategory | null> = {
  all: null,
  images: 'image',
  videos: 'video',
  audio: 'audio',
  other: 'other',
};

const CATEGORIES: { id: FilterCategory; label: string; icon: React.ElementType }[] = [
  { id: 'all', label: 'All', icon: Filter },
  { id: 'images', label: 'Images', icon: ImageIcon },
  { id: 'videos', label: 'Videos', icon: Film },
  { id: 'audio', label: 'Audio', icon: Music },
  { id: 'other', label: 'Other', icon: File },
];



interface ResultCardProps {
  resource: CacheResource;
  isPreview: boolean;
  onToggleSelection: (id: string) => void;
  onPreview: (resource: CacheResource) => void;
}

const ResultCard = memo(function ResultCard({
  resource,
  isPreview,
  onToggleSelection,
  onPreview,
}: ResultCardProps) {
  const Icon = getIconForCategory(resource.mediaCategory);
  const isSelected = resource.selected;
  const hasPreview = !!resource.previewUrl;

  return (
    <div
      onClick={() => onPreview(resource)}
      className={`
        group relative aspect-square rounded-xl overflow-hidden cursor-pointer border-2 transition-all duration-200 bg-surface-1
        ${isSelected ? 'border-phoenix bg-phoenix/5' : 'border-surface-2 hover:border-surface-3'}
        ${isPreview ? 'ring-2 ring-white ring-offset-2 ring-offset-background z-10' : ''}
      `}
    >
      <div
        className="absolute top-2 left-2 z-20"
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelection(resource.id);
        }}
      >
        <div className={`
          w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all shadow-lg backdrop-blur-sm
          ${isSelected
            ? 'bg-phoenix border-phoenix text-white'
            : 'bg-surface-1/80 border-text-muted/30 hover:border-text-primary'
          }
        `}>
          {isSelected && <Check className="w-3.5 h-3.5" />}
        </div>
      </div>

      {hasPreview ? (
        <>
          <div className="absolute inset-0 w-full h-full overflow-hidden">
            <img
              src={resource.previewUrl}
              alt={resource.displayName}
              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
              loading="lazy"
              decoding="async"
            />
            <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
          </div>

          <div className="absolute top-2 right-2 z-10">
            <div className={`
              p-1.5 rounded-lg backdrop-blur-md shadow-md transition-all
              ${resource.mediaCategory === 'video' ? 'bg-red-500/30 text-red-300' :
                resource.mediaCategory === 'image' ? 'bg-blue-500/30 text-blue-300' :
                  'bg-surface-2/60 text-text-muted'}
            `}>
              <Icon className="w-3.5 h-3.5" />
            </div>
          </div>

          <div className="absolute inset-x-0 bottom-0 z-10 p-3">
            <p className="text-sm font-medium truncate text-white drop-shadow-md" title={resource.displayName}>
              {resource.displayName}
            </p>
            <div className="flex items-center space-x-2 mt-1">
              <span className={`
                text-[10px] uppercase font-bold px-1.5 py-0.5 rounded
                ${resource.mediaCategory === 'video' ? 'bg-red-500/30 text-red-300' :
                  resource.mediaCategory === 'image' ? 'bg-blue-500/30 text-blue-300' :
                    'bg-white/20 text-white/80'}
              `}>
                {resource.resourceType}
              </span>
              <span className="text-xs text-white/70 font-mono">
                {formatBytes(resource.totalSize)}
              </span>
            </div>
            {resource.modifiedAt ? (
              <div className="flex items-center space-x-1 mt-1">
                <Clock className="w-2.5 h-2.5 text-white/50" />
                <span className="text-[10px] text-white/50">{formatDateTime(resource.modifiedAt)}</span>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center h-full p-4 space-y-3">
          <div className={`
            p-4 rounded-full bg-surface-2/80 backdrop-blur-sm group-hover:scale-110 transition-transform duration-300
            ${isSelected ? 'text-phoenix' : 'text-text-muted'}
          `}>
            <Icon className="w-8 h-8" />
          </div>

          <div className="text-center w-full">
            <p className="text-sm font-medium truncate w-full px-2" title={resource.displayName}>
              {resource.displayName}
            </p>
            <div className="flex items-center justify-center space-x-2 mt-1">
              <span className={`
                text-[10px] uppercase font-bold px-1.5 py-0.5 rounded
                ${resource.mediaCategory === 'video' ? 'bg-red-500/20 text-red-400' :
                  resource.mediaCategory === 'image' ? 'bg-blue-500/20 text-blue-400' :
                    'bg-surface-3 text-text-muted'}
              `}>
                {resource.resourceType}
              </span>
              <span className="text-xs text-text-muted font-mono">
                {formatBytes(resource.totalSize)}
              </span>
            </div>
            {resource.modifiedAt ? (
              <div className="flex items-center justify-center space-x-1 mt-1.5">
                <Clock className="w-2.5 h-2.5 text-text-muted/50" />
                <span className="text-[10px] text-text-muted/70">{formatDateTime(resource.modifiedAt)}</span>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {(resource.files.length > 1 || resource.videoInfo) && (
        <div className="absolute bottom-0 left-0 right-0 bg-black/60 backdrop-blur-sm p-1.5 text-[10px] text-center text-white/90 font-mono z-10">
          {resource.files.length > 1 && `${resource.files.length} chunks`}
          {resource.videoInfo && ` • ${formatDuration(resource.videoInfo.duration)}`}
        </div>
      )}
    </div>
  );
});



function useColumnCount(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [columns, setColumns] = useState(4);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const compute = () => {
      const width = el.clientWidth;
      // Match the Tailwind breakpoints: 2 cols base, 3 md(768), 4 lg(1024), 5 xl(1280)
      if (width >= 1280) setColumns(5);
      else if (width >= 1024) setColumns(4);
      else if (width >= 768) setColumns(3);
      else setColumns(2);
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  return columns;
}



export default function ScanResults() {
  const resources = useAppStore((s) => s.resources);
  const filterCategory = useAppStore((s) => s.filterCategory);
  const setFilterCategory = useAppStore((s) => s.setFilterCategory);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const toggleResourceSelection = useAppStore((s) => s.toggleResourceSelection);
  const selectAllResources = useAppStore((s) => s.selectAllResources);
  const deselectAllResources = useAppStore((s) => s.deselectAllResources);
  const setPreviewResource = useAppStore((s) => s.setPreviewResource);
  const previewResource = useAppStore((s) => s.previewResource);
  const setScannerStep = useAppStore((s) => s.setScannerStep);
  const sortOrder = useAppStore((s) => s.sortOrder);
  const setSortOrder = useAppStore((s) => s.setSortOrder);
  const resetScanner = useAppStore((s) => s.resetScanner);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const columns = useColumnCount(scrollContainerRef);

  const handleContinue = useCallback(() => {
    if (resources.some(r => r.selected)) {
      setScannerStep('recovery');
    }
  }, [resources, setScannerStep]);

  const handleNewScan = useCallback(() => {
    cancelCurrentScan();
    resetScanner();
  }, [resetScanner]);

  const toggleSortOrder = useCallback(() => {
    setSortOrder(sortOrder === 'newest' ? 'oldest' : 'newest');
  }, [sortOrder, setSortOrder]);

  const filteredAndSortedResources = useMemo(() => {
    const mediaMatch = CATEGORY_TO_MEDIA[filterCategory];
    const lowerSearch = searchQuery.toLowerCase();

    const filtered = resources.filter(r => {
      const matchesCategory = filterCategory === 'all' || r.mediaCategory === mediaMatch;
      const matchesSearch = !searchQuery || r.displayName.toLowerCase().includes(lowerSearch);
      return matchesCategory && matchesSearch;
    });

    return filtered.sort((a, b) => {
      const aTime = a.modifiedAt || 0;
      const bTime = b.modifiedAt || 0;
      return sortOrder === 'newest' ? bTime - aTime : aTime - bTime;
    });
  }, [resources, filterCategory, searchQuery, sortOrder]);

  const selectedCount = useMemo(
    () => resources.reduce((count, r) => count + (r.selected ? 1 : 0), 0),
    [resources],
  );

  const previewResourceId = previewResource?.id ?? null;

  const rowCount = Math.ceil(filteredAndSortedResources.length / columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 220,
    overscan: 3,
  });

  const onToggleSelection = useCallback((id: string) => {
    toggleResourceSelection(id);
  }, [toggleResourceSelection]);

  const onPreview = useCallback((resource: CacheResource) => {
    setPreviewResource(resource);
  }, [setPreviewResource]);

  const clearFilters = useCallback(() => {
    setFilterCategory('all');
    setSearchQuery('');
  }, [setFilterCategory, setSearchQuery]);

  return (
    <div className="flex flex-col h-full min-h-0 animate-fade-in">
      {/* ─── Header / Toolbar ──────────────────────────────────────────── */}
      <div className="shrink-0 flex flex-col space-y-4 bg-surface-1/50 p-4 rounded-xl border border-surface-2 backdrop-blur-sm z-20">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <h2 className="text-2xl font-bold">Scan Results</h2>
            <span className="bg-phoenix/20 text-phoenix px-3 py-1 rounded-full text-sm font-bold">
              {filteredAndSortedResources.length}
            </span>
            <button
              onClick={handleNewScan}
              className="flex items-center space-x-1.5 px-3 py-1 rounded-full text-sm font-medium text-text-muted hover:text-phoenix hover:bg-phoenix/10 transition-all"
              title="Start a new scan"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>New Scan</span>
            </button>
          </div>

          <div className="flex items-center space-x-2 text-sm">
            <span className="text-text-muted">
              {selectedCount} of {resources.length} selected
            </span>
            <div className="h-4 w-px bg-surface-3 mx-2"></div>
            <button
              onClick={selectAllResources}
              className="text-phoenix hover:underline font-medium"
            >
              Select All
            </button>
            <span className="text-surface-3">/</span>
            <button
              onClick={deselectAllResources}
              className="text-text-muted hover:text-text-primary transition-colors"
            >
              Deselect All
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between space-x-4">
          <div className="flex bg-surface-2 p-1 rounded-lg">
            {CATEGORIES.map((cat) => {
              const Icon = cat.icon;
              const isActive = filterCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  onClick={() => setFilterCategory(cat.id)}
                  className={`
                    flex items-center px-4 py-2 rounded-md text-sm font-medium transition-all duration-200
                    ${isActive
                      ? 'bg-phoenix text-white shadow-sm'
                      : 'text-text-muted hover:text-text-primary hover:bg-white/5'
                    }
                  `}
                >
                  <Icon className="w-4 h-4 mr-2" />
                  {cat.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center space-x-3">
            <button
              onClick={toggleSortOrder}
              className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-surface-2 border border-surface-3 text-sm font-medium text-text-muted hover:text-text-primary hover:border-phoenix/50 transition-all"
              title={`Sort by date: ${sortOrder === 'newest' ? 'Newest first' : 'Oldest first'}`}
            >
              {sortOrder === 'newest' ? (
                <ArrowDown className="w-3.5 h-3.5" />
              ) : (
                <ArrowUp className="w-3.5 h-3.5" />
              )}
              <span>{sortOrder === 'newest' ? 'Newest' : 'Oldest'}</span>
            </button>

            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-text-muted w-4 h-4" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search files..."
                className="w-full bg-surface-2 border border-surface-3 text-text-primary rounded-lg pl-10 pr-4 py-2 focus:outline-none focus:border-phoenix focus:ring-1 focus:ring-phoenix transition-all"
              />
            </div>
          </div>
        </div>
      </div>

      {/* ─── Virtualized Grid ──────────────────────────────────────────── */}
      <div
        ref={scrollContainerRef}
        className="flex-1 min-h-0 overflow-y-auto"
      >
        {filteredAndSortedResources.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-text-muted space-y-4">
            <Search className="w-16 h-16 opacity-20" />
            <p className="text-lg font-medium">No results found matching your criteria</p>
            <button
              onClick={clearFilters}
              className="text-phoenix hover:underline"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const startIndex = virtualRow.index * columns;
              const rowItems = filteredAndSortedResources.slice(startIndex, startIndex + columns);

              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div
                    className="grid gap-4"
                    style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                  >
                    {rowItems.map((resource) => (
                      <ResultCard
                        key={resource.id}
                        resource={resource}
                        isPreview={previewResourceId === resource.id}
                        onToggleSelection={onToggleSelection}
                        onPreview={onPreview}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ─── Preview Modal ─────────────────────────────────────────────── */}
      {previewResource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in p-8" onClick={() => setPreviewResource(null)}>
          <div className="bg-surface-1 border border-surface-3 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-surface-2 bg-surface-2/50">
              <h3 className="text-xl font-bold truncate pr-4">{previewResource.displayName}</h3>
              <button
                onClick={() => setPreviewResource(null)}
                className="p-2 hover:bg-surface-3 rounded-full transition-colors"
              >
                <ChevronRight className="w-5 h-5 rotate-90" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-6">
              {previewResource.previewUrl ? (
                <div className="flex items-center justify-center py-4 bg-black/40 rounded-xl border border-surface-3 overflow-hidden relative min-h-[300px]">
                  <img
                    src={previewResource.previewUrl}
                    alt={previewResource.displayName}
                    className="max-w-full max-h-[50vh] object-contain"
                  />
                </div>
              ) : (
                <div className="flex items-center justify-center py-8 bg-surface-2/30 rounded-xl border border-dashed border-surface-3">
                  <div className="text-center space-y-2">
                    <Maximize2 className="w-12 h-12 mx-auto text-text-muted opacity-50" />
                    <p className="text-text-muted text-sm">Preview not available for raw cache files</p>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="space-y-1">
                  <span className="text-text-muted block text-xs uppercase tracking-wider">Type</span>
                  <span className="font-mono">{previewResource.resourceType}</span>
                </div>
                <div className="space-y-1">
                  <span className="text-text-muted block text-xs uppercase tracking-wider">Size</span>
                  <span className="font-mono">{formatBytes(previewResource.totalSize)}</span>
                </div>
                <div className="space-y-1">
                  <span className="text-text-muted block text-xs uppercase tracking-wider">Category</span>
                  <span className="capitalize">{previewResource.mediaCategory}</span>
                </div>
                {previewResource.files.length > 1 && (
                <div className="space-y-1">
                  <span className="text-text-muted block text-xs uppercase tracking-wider">Chunks</span>
                  <span className="font-mono">{previewResource.files.length}</span>
                </div>
                )}
                {previewResource.modifiedAt ? (
                  <div className="space-y-1 col-span-2">
                    <span className="text-text-muted block text-xs uppercase tracking-wider">Modified</span>
                    <span className="font-mono">{formatDateTime(previewResource.modifiedAt)}</span>
                  </div>
                ) : null}
              </div>

              {previewResource.files.length > 0 && (
                <div className="space-y-2">
                  <span className="text-text-muted block text-xs uppercase tracking-wider">{previewResource.files.length > 1 ? 'Source Chunks' : 'Source File'}</span>
                  <div className="max-h-32 overflow-y-auto rounded-lg border border-surface-2 bg-black/20 p-2 space-y-1">
                    {previewResource.files.map((chunk, i) => (
                      <div key={i} className="font-mono text-xs text-text-muted truncate">
                        {chunk.path}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="p-4 border-t border-surface-2 bg-surface-2/30 flex justify-end">
              <button
                onClick={() => {
                  toggleResourceSelection(previewResource.id);
                  setPreviewResource(null);
                }}
                className={`
                  px-6 py-2 rounded-lg font-bold text-sm transition-all
                  ${previewResource.selected
                    ? 'bg-transparent border border-phoenix text-phoenix hover:bg-phoenix/10'
                    : 'bg-phoenix text-white hover:bg-phoenix-hover'
                  }
                `}
              >
                {previewResource.selected ? 'Deselect Item' : 'Select Item'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Footer ────────────────────────────────────────────────────── */}
      <div className="shrink-0 pt-4 border-t border-surface-2 flex justify-between items-center bg-surface-0/95 backdrop-blur z-10">
        <div className="text-sm text-text-muted">
          {selectedCount > 0 ? (
            <span className="text-phoenix font-medium">{selectedCount} items ready for recovery</span>
          ) : (
            <span>Select items to proceed</span>
          )}
        </div>
        <button
          onClick={handleContinue}
          disabled={selectedCount === 0}
          className={`
            flex items-center px-8 py-3 rounded-lg font-bold text-lg transition-all duration-300 shadow-lg
            ${selectedCount > 0
              ? 'bg-phoenix hover:bg-phoenix-hover text-white shadow-phoenix/30 hover:shadow-phoenix/50 transform hover:-translate-y-0.5'
              : 'bg-surface-3 text-text-muted cursor-not-allowed'
            }
          `}
        >
          <span>Continue to Recovery</span>
          <ChevronRight className="w-5 h-5 ml-2" />
        </button>
      </div>
    </div>
  );
}
