import { useEffect, useState, useCallback } from 'react';
import { useAppStore } from '@/store';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { formatBytes } from '@/lib/utils';
import { 
  Plus, 
  HardDrive, 
  CheckCircle, 
  RefreshCw,
  ChevronRight,
  X
} from 'lucide-react';
import type { CachePathInfo } from '@/types';
import { isMacOS, probeFullDiskAccess, testPathAccess, type FdaProbeResult, type PathAccessResult } from '@/lib/permissions';
import FullDiskAccessDialog from './FullDiskAccessDialog';

const CUSTOM_PATHS_KEY = 'customCachePaths';

function getStoredCustomPaths(): string[] {
  try {
    const stored = localStorage.getItem(CUSTOM_PATHS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Corrupted data — ignore
  }
  return [];
}

function saveCustomPaths(paths: string[]) {
  localStorage.setItem(CUSTOM_PATHS_KEY, JSON.stringify(paths));
}

export default function CacheFolderSelect() {
  const { 
    cachePaths, 
    setCachePaths, 
    removeFromCachePaths,
    selectedPaths, 
    togglePathSelection, 
    setScannerStep, 
    setIsScanning 
  } = useAppStore();
  
  const [loading, setLoading] = useState(true);
  const [autoDetectedPaths, setAutoDetectedPaths] = useState<Set<string>>(new Set());
  const [showFdaDialog, setShowFdaDialog] = useState(false);
  const [fdaProbe, setFdaProbe] = useState<FdaProbeResult | null>(null);
  const [pathAccessResult, setPathAccessResult] = useState<PathAccessResult | null>(null);

  useEffect(() => {
    const detectPaths = async () => {
      setLoading(true);
      try {
        // 1. Auto-detect paths from Rust backend
        const defaultPaths = await invoke<string[]>('get_default_cache_paths');
        const validatedPaths: CachePathInfo[] = [];

        for (const path of defaultPaths) {
          try {
            const info = await invoke<CachePathInfo>('validate_cache_path', { path });
            validatedPaths.push(info);
          } catch (e) {
            console.error(`Failed to validate path ${path}`, e);
          }
        }

        // Track which paths are auto-detected
        const autoDetected = new Set(validatedPaths.map(p => p.path));
        setAutoDetectedPaths(autoDetected);

        // 2. Load custom paths from localStorage and merge
        const storedCustom = getStoredCustomPaths();
        const customValidated: CachePathInfo[] = [];

        for (const customPath of storedCustom) {
          // Skip if already in auto-detected (auto-detect takes precedence)
          if (autoDetected.has(customPath)) continue;
          try {
            const info = await invoke<CachePathInfo>('validate_cache_path', { path: customPath });
            customValidated.push(info);
          } catch (e) {
            console.error(`Failed to validate custom path ${customPath}`, e);
          }
        }

        setCachePaths([...validatedPaths, ...customValidated]);
      } catch (e) {
        console.error('Failed to detect cache paths', e);
      } finally {
        setLoading(false);
      }
    };

    if (cachePaths.length === 0) {
      detectPaths();
    } else {
      setLoading(false);
    }
  }, [setCachePaths, cachePaths.length]);

  const handleAddCustomFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Cache Folder',
      });

      if (selected && typeof selected === 'string') {
        const info = await invoke<CachePathInfo>('validate_cache_path', { path: selected });
        // Add to store if not exists
        if (!cachePaths.find(p => p.path === info.path)) {
          setCachePaths([...cachePaths, info]);
          // Persist to localStorage
          const stored = getStoredCustomPaths();
          if (!stored.includes(info.path)) {
            saveCustomPaths([...stored, info.path]);
          }
        }
      }
    } catch (e) {
      console.error('Failed to add custom folder', e);
    }
  };

  const handleRemoveCustomFolder = (e: React.MouseEvent, path: string) => {
    e.stopPropagation(); // Don't toggle selection
    removeFromCachePaths(path);
    // Remove from localStorage
    const stored = getStoredCustomPaths();
    saveCustomPaths(stored.filter(p => p !== path));
  };

  const isCustomPath = (path: string) => !autoDetectedPaths.has(path);

  const proceedWithScan = useCallback(() => {
    if (selectedPaths.length > 0) {
      setIsScanning(true);
      setScannerStep('scanning');
    }
  }, [selectedPaths.length, setIsScanning, setScannerStep]);

  const handleStartScan = async () => {
    if (selectedPaths.length === 0) return;

    // On macOS, verify both FDA and actual path read access before scanning
    if (isMacOS()) {
      // Step 1: Real FDA probe
      const probe = await probeFullDiskAccess();
      setFdaProbe(probe);

      if (!probe.has_access) {
        setShowFdaDialog(true);
        return;
      }

      // Step 2: FDA probe passed — now verify we can actually READ files in the selected paths
      // This catches cases where FDA is granted but POSIX permissions still block reads
      for (const selectedPath of selectedPaths) {
        const access = await testPathAccess(selectedPath);
        if (access.file_read_test.tested && !access.file_read_test.success) {
          console.warn(
            `[scan] Path access test FAILED for ${selectedPath}:`,
            `errno=${access.file_read_test.error_code}`,
            access.file_read_test.error_msg
          );
          setPathAccessResult(access);
          setShowFdaDialog(true);
          return;
        }
      }
    }


    // [DIAGNOSTIC] Run file-read diagnosis on first _s file found in selected paths
    // This logs detailed results showing which read strategies work vs fail
    if (isMacOS()) {
      try {
        const files = await invoke<Array<{name: string; path: string; size: number}>>('list_cache_files', { dir: selectedPaths[0] });
        const sparseFile = files.find(f => f.name.endsWith('_s') && f.size > 1000);
        const streamFile = files.find(f => f.name.endsWith('_0'));
        if (sparseFile) {
          const diagS = await invoke('diagnose_file_read', { path: sparseFile.path });
          console.log('[DIAGNOSTIC] _s file read test:', JSON.stringify(diagS, null, 2));
        }
        if (streamFile) {
          const diag0 = await invoke('diagnose_file_read', { path: streamFile.path });
          console.log('[DIAGNOSTIC] _0 file read test:', JSON.stringify(diag0, null, 2));
        }
      } catch (e) {
        console.warn('[DIAGNOSTIC] Failed to run file read diagnosis:', e);
      }
    }
    proceedWithScan();
  };

  const getClientLabel = (clientName: string) => {
    switch (clientName.toLowerCase()) {
      case 'discord': return 'Stable';
      case 'discord ptb': return 'PTB';
      case 'discord canary': return 'Canary';
      case 'discord development': return 'Dev';
      case 'chrome': return 'Browser';
      case 'brave': return 'Browser';
      case 'edge': return 'Browser';
      case 'opera': return 'Browser';
      default: return 'Custom';
    }
  };

  const getClientColor = (clientName: string) => {
    switch (clientName.toLowerCase()) {
      case 'discord': return 'bg-[#5865F2] text-white';
      case 'discord ptb': return 'bg-blue-500 text-white';
      case 'discord canary': return 'bg-yellow-500 text-black';
      case 'discord development': return 'bg-zinc-700 text-white';
      case 'chrome': return 'bg-green-600 text-white';
      case 'brave': return 'bg-orange-500 text-white';
      case 'edge': return 'bg-cyan-600 text-white';
      case 'opera': return 'bg-red-600 text-white';
      default: return 'bg-surface-3 text-text-primary';
    }
  };

  return (
    <>
      <FullDiskAccessDialog
        open={showFdaDialog}
        onOpenChange={setShowFdaDialog}
        onRetry={proceedWithScan}
        fdaProbe={fdaProbe}
        pathAccess={pathAccessResult}
      />

    <div className="flex flex-col h-full min-h-0 animate-fade-in">
      <div className="flex-1 min-h-0 overflow-y-auto space-y-6">
        <div className="space-y-2 text-center">
          <h2 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-text-muted">
            Select Cache Source
          </h2>
          <p className="text-text-muted max-w-lg mx-auto">
            Choose where to scan for recoverable media. We've auto-detected available cache sources on your system.
          </p>
        </div>
      <div className="px-1 py-4">
          {loading ? (
            <div className="flex items-center justify-center h-40 space-x-3 text-phoenix">
              <RefreshCw className="w-6 h-6 animate-spin" />
              <span>Detecting cache sources...</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {cachePaths.filter(p => p.exists).map((pathInfo) => {
                const isSelected = selectedPaths.includes(pathInfo.path);
                const isCustom = isCustomPath(pathInfo.path);
                return (
                  <div 
                    key={pathInfo.path}
                    onClick={() => togglePathSelection(pathInfo.path)}
                    className={`
                      relative group p-4 rounded-xl border-2 transition-all duration-200 cursor-pointer overflow-hidden
                      ${isSelected 
                        ? 'border-phoenix bg-phoenix/10 shadow-[0_0_15px_rgba(255,107,53,0.15)]' 
                        : 'border-surface-2 bg-surface-1 hover:border-surface-3 hover:bg-surface-2'
                      }
                    `}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center space-x-3">
                        <div className={`p-2 rounded-lg ${getClientColor(pathInfo.client_name)}`}>
                          <HardDrive className="w-5 h-5" />
                        </div>
                        <div>
                          <div className="flex items-center space-x-2">
                            <h3 className="font-bold text-lg capitalize">{pathInfo.client_name}</h3>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wider ${getClientColor(pathInfo.client_name)} opacity-80`}>
                              {getClientLabel(pathInfo.client_name)}
                            </span>
                          </div>
                          <p className="text-xs font-mono text-text-muted mt-1 truncate max-w-[200px]" title={pathInfo.path}>
                            {pathInfo.path}
                          </p>
                        </div>
                      </div>
                      
                      <div className="flex items-center space-x-2">
                        {isCustom && (
                          <button
                            onClick={(e) => handleRemoveCustomFolder(e, pathInfo.path)}
                            className="w-6 h-6 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-red-400 hover:bg-red-400/10"
                            title="Remove custom folder"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        )}
                        <div className={`
                          w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all
                          ${isSelected ? 'bg-phoenix border-phoenix' : 'border-text-muted/30'}
                        `}>
                          {isSelected && <CheckCircle className="w-4 h-4 text-white" />}
                        </div>
                      </div>
                    </div>
                  <div className="mt-4 flex items-center justify-between text-sm">
                      <div className="flex space-x-4">
                        <div className="flex flex-col">
                          <span className="text-xs text-text-muted">Files</span>
                          <span className="font-mono font-medium">{pathInfo.file_count.toLocaleString()}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-xs text-text-muted">Size</span>
                          <span className="font-mono font-medium">{formatBytes(pathInfo.total_size)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}

              <button 
                onClick={handleAddCustomFolder}
                className="flex flex-col items-center justify-center p-6 rounded-xl border-2 border-dashed border-surface-3 text-text-muted hover:border-phoenix hover:text-phoenix hover:bg-phoenix/5 transition-all duration-200 group h-full min-h-[140px]"
              >
                <div className="w-12 h-12 rounded-full bg-surface-2 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                  <Plus className="w-6 h-6" />
                </div>
                <span className="font-medium">Add Custom Folder</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 pt-4 border-t border-surface-2 flex justify-end">
        <button
          onClick={handleStartScan}
          disabled={selectedPaths.length === 0}
          className={`
            flex items-center px-8 py-3 rounded-lg font-bold text-lg transition-all duration-300 shadow-lg
            ${selectedPaths.length > 0 
              ? 'bg-phoenix hover:bg-phoenix-hover text-white shadow-phoenix/30 hover:shadow-phoenix/50 transform hover:-translate-y-0.5' 
              : 'bg-surface-3 text-text-muted cursor-not-allowed'
            }
          `}
        >
          <span>Start Scan</span>
          <ChevronRight className="w-5 h-5 ml-2" />
        </button>
      </div>
    </div>
    </>
  );
}
