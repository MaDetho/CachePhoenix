import { scanCacheFolder } from "@/lib/scanner";
import { useAppStore } from "@/store";
import type { CacheResource, ScanDebugData } from "@/types";

// Module-level scan state — survives component mount/unmount
let currentScanAbortController: AbortController | null = null;
let isScanRunning = false;

export function isCurrentlyScanning(): boolean {
  return isScanRunning;
}

export function cancelCurrentScan(): void {
  if (currentScanAbortController) {
    currentScanAbortController.abort();
    currentScanAbortController = null;
  }
  isScanRunning = false;
}

export async function startScan(selectedPaths: string[]): Promise<void> {
  // Cancel any existing scan first
  cancelCurrentScan();

  const abortController = new AbortController();
  currentScanAbortController = abortController;
  isScanRunning = true;

  const allResources: CacheResource[] = [];
  let lastDebugData: ScanDebugData | null = null;

  try {
    for (const path of selectedPaths) {
      if (abortController.signal.aborted) break;

      const { resources, debugData } = await scanCacheFolder(path, (progress) => {
        if (!abortController.signal.aborted) {
          useAppStore.getState().setScanProgress({
            current: progress.current,
            total: progress.total,
            currentFile: progress.currentFile,
            phase: progress.phase,
          });
        }
      });

      if (!abortController.signal.aborted) {
        allResources.push(...resources);
        lastDebugData = debugData;
      }
    }

    if (!abortController.signal.aborted) {
      console.log(`[CachePhoenix][DEBUG] === SCAN COMPLETE ===`);
      console.log(`[CachePhoenix][DEBUG] Total resources: ${allResources.length}`);
      const withMetadata = allResources.filter(r => r.indexUrl || r.indexContentType || r.indexHeaders);
      console.log(`[CachePhoenix][DEBUG] Resources WITH index metadata: ${withMetadata.length}`);
      const withDiscord = allResources.filter(r => r.discordInfo);
      console.log(`[CachePhoenix][DEBUG] Resources WITH discordInfo: ${withDiscord.length}`);
      if (withMetadata.length > 0) {
        const s = withMetadata[0];
        console.log(`[CachePhoenix][DEBUG] Sample resource with metadata:`, { id: s.id, indexUrl: s.indexUrl?.slice(0,80), indexContentType: s.indexContentType, indexHttpStatus: s.indexHttpStatus, indexHeaders: s.indexHeaders ? Object.keys(s.indexHeaders).length + ' headers' : 'none', discordInfo: s.discordInfo });
      } else {
        console.warn(`[CachePhoenix][DEBUG] ⚠️ NO resources have metadata! Check parse_blockfile_index output.`);
        if (allResources.length > 0) {
          const s = allResources[0];
          console.log(`[CachePhoenix][DEBUG] Sample resource WITHOUT metadata:`, { id: s.id, displayName: s.displayName, resourceType: s.resourceType, files: s.files?.length, indexUrl: s.indexUrl, indexContentType: s.indexContentType });
        }
      }
      useAppStore.getState().setScanDebugData(lastDebugData);
      useAppStore.getState().setResources(allResources);
      useAppStore.getState().setIsScanning(false);
      useAppStore.getState().setScannerStep("results");
    }
  } catch (error) {
    console.error("Scan failed:", error);
    if (!abortController.signal.aborted) {
      useAppStore.getState().setIsScanning(false);
    }
  } finally {
    if (currentScanAbortController === abortController) {
      currentScanAbortController = null;
      isScanRunning = false;
    }
  }
}