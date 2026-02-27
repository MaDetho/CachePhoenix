import { scanCacheFolder } from "@/lib/scanner";
import { useAppStore } from "@/store";
import type { CacheResource } from "@/types";

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

  try {
    for (const path of selectedPaths) {
      if (abortController.signal.aborted) break;

      const resources = await scanCacheFolder(path, (progress) => {
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
      }
    }

    if (!abortController.signal.aborted) {
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