import { useEffect, useRef } from 'react';
import { useAppStore } from '@/store';
import { recoverResources } from '@/lib/recovery';
import { invoke } from '@tauri-apps/api/core';
import { 
  CheckCircle, 
  AlertCircle, 
  FolderOpen, 
  RefreshCw,
  Terminal
} from 'lucide-react';

export default function RecoveryProgress() {
  const { 
    resources, 
    recoveryOptions, 
    recoveryProgress, 
    setRecoveryProgress, 
    setIsRecovering, 
    setScannerStep,
    setResources,
    setScanProgress,
    setFilterCategory,
    setSearchQuery
  } = useAppStore();

  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [recoveryProgress?.log]);

  const hasStartedRef = useRef(false);

  useEffect(() => {
    // Guard against React.StrictMode double-invocation in dev mode.
    // Without this, the entire recovery pipeline (including ffmpeg sidecar
    // processes) runs twice simultaneously, corrupting output files.
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;

    const selected = resources.filter(r => r.selected);
    if (selected.length === 0) return;

    const runRecovery = async () => {
      try {
        await recoverResources(selected, recoveryOptions, (progress) => {
          setRecoveryProgress(progress);
        });
      } catch (e) {
        console.error('Recovery failed', e);
      } finally {
        setIsRecovering(false);
      }
    };

    runRecovery();
  }, []);

  const handleOpenFolder = () => {
    if (recoveryOptions.outputFolder) {
      invoke('open_folder', { path: recoveryOptions.outputFolder });
    }
  };

  const handleScanAgain = () => {
    setResources([]);
    setScanProgress({ current: 0, total: 0, currentFile: '', phase: 'listing' });
    setRecoveryProgress(null);
    setFilterCategory('all');
    setSearchQuery('');
    setScannerStep('select');
  };

  const isComplete = recoveryProgress?.phase === 'complete';
  const hasErrors = (recoveryProgress?.errors.length || 0) > 0;
  const percent = recoveryProgress?.total 
    ? Math.round((recoveryProgress.current / recoveryProgress.total) * 100) 
    : 0;

  return (
    <div className="flex flex-col h-full space-y-4 animate-fade-in max-w-5xl mx-auto min-h-0">
      <div className="text-center space-y-3 pt-2 shrink-0">
        {isComplete ? (
          <div className="flex flex-col items-center space-y-4 animate-scale-in">
            <div className="w-20 h-20 rounded-full bg-success/20 flex items-center justify-center text-success border-2 border-success shadow-[0_0_30px_rgba(34,197,94,0.3)]">
              <CheckCircle className="w-10 h-10" />
            </div>
            <h2 className="text-3xl font-bold text-white">Recovery Complete!</h2>
            <p className="text-text-muted">
              Successfully recovered {recoveryProgress?.current} files.
              {hasErrors && <span className="text-error ml-2">({recoveryProgress?.errors.length} errors)</span>}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold animate-pulse">Recovering files...</h2>
            
            <div className="relative pt-1">
              <div className="flex mb-2 items-center justify-between">
                <div>
                  <span className="text-xs font-semibold inline-block py-1 px-2 uppercase rounded-full text-phoenix bg-phoenix/10">
                    {recoveryProgress?.phase || 'Initializing'}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-xs font-semibold inline-block text-phoenix">
                    {percent}%
                  </span>
                </div>
              </div>
              <div className="overflow-hidden h-2 mb-4 text-xs flex rounded bg-surface-3">
                <div style={{ width: `${percent}%` }} className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-phoenix transition-all duration-300 ease-out"></div>
              </div>
              <p className="text-sm font-mono text-text-muted truncate h-6">
                {recoveryProgress?.currentFile || 'Preparing...'}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col space-y-3 overflow-hidden">
        <div className="flex-1 bg-surface-1 border border-surface-3 rounded-xl overflow-hidden flex flex-col shadow-inner">
          <div className="bg-surface-2/50 px-4 py-2 border-b border-surface-3 flex items-center justify-between">
            <div className="flex items-center space-x-2 text-text-muted text-sm font-mono">
              <Terminal className="w-4 h-4" />
              <span>Recovery Log</span>
            </div>
            <span className="text-xs text-text-muted">
              {recoveryProgress?.log.length || 0} entries
            </span>
          </div>
          <div ref={logContainerRef} className="flex-1 p-4 overflow-y-auto font-mono text-xs space-y-1 bg-black/20">
            {recoveryProgress?.log.map((entry, i) => (
              <div key={i} className="text-text-muted leading-5">
                {entry}
              </div>
            ))}
          </div>
        </div>

        {hasErrors && (
          <div className="bg-surface-1/50 border border-error/30 rounded-xl overflow-hidden">
            <div className="bg-error/10 px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-error/20 transition-colors">
              <div className="flex items-center space-x-2 text-error font-medium">
                <AlertCircle className="w-5 h-5" />
                <span>{recoveryProgress?.errors.length} Errors Occurred</span>
              </div>
            </div>
            <div className="max-h-40 overflow-y-auto p-4 space-y-2 bg-black/20">
              {recoveryProgress?.errors.map((error, i) => (
                <div key={i} className="text-xs text-error/80 font-mono border-l-2 border-error/30 pl-3">
                  <div>{error}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="py-3 flex justify-center space-x-4 shrink-0">
        {isComplete && (
          <>
            <button
              onClick={handleScanAgain}
              className="flex items-center px-6 py-3 rounded-lg font-medium text-text-muted hover:text-text-primary hover:bg-surface-2 transition-all"
            >
              <RefreshCw className="w-5 h-5 mr-2" />
              Scan Again
            </button>
            <button
              onClick={handleOpenFolder}
              className="flex items-center px-8 py-3 rounded-lg font-bold text-white bg-phoenix hover:bg-phoenix-hover shadow-lg shadow-phoenix/30 hover:shadow-phoenix/50 transform hover:-translate-y-0.5 transition-all"
            >
              <FolderOpen className="w-5 h-5 mr-2" />
              Open Output Folder
            </button>
          </>
        )}
      </div>
    </div>
  );
}
