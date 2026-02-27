import { useEffect } from 'react';
import { useAppStore } from '@/store';
import { startScan, cancelCurrentScan, isCurrentlyScanning } from '@/lib/scanService';
import { XCircle } from 'lucide-react';

export default function ScanProgress() {
  const { 
    selectedPaths, 
    scanProgress, 
    setIsScanning, 
    setScannerStep 
  } = useAppStore();

  useEffect(() => {
    // Only start a new scan if one isn't already running
    // (e.g., user navigated away and came back — scan is still in progress)
    if (!isCurrentlyScanning()) {
      startScan(selectedPaths);
    }
    // No cleanup — scan continues even if this component unmounts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCancel = () => {
    cancelCurrentScan();
    setIsScanning(false);
    setScannerStep('select');
  };

  const percent = scanProgress.total > 0 
    ? Math.round((scanProgress.current / scanProgress.total) * 100) 
    : 0;

  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] space-y-8 animate-fade-in">
      <div className="relative w-64 h-64 flex items-center justify-center">
        <svg className="absolute w-full h-full transform -rotate-90">
          <circle
            cx="128"
            cy="128"
            r="120"
            fill="transparent"
            stroke="currentColor"
            strokeWidth="8"
            className="text-surface-3"
          />
          <circle
            cx="128"
            cy="128"
            r="120"
            fill="transparent"
            stroke="currentColor"
            strokeWidth="8"
            strokeDasharray={2 * Math.PI * 120}
            strokeDashoffset={2 * Math.PI * 120 * (1 - percent / 100)}
            strokeLinecap="round"
            className="text-phoenix transition-all duration-300 ease-out"
          />
        </svg>
        
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-8">
          <span className="text-6xl font-bold bg-clip-text text-transparent bg-gradient-to-br from-white to-text-muted mb-2 font-mono">
            {percent}%
          </span>
          <span className="text-sm font-medium text-text-muted uppercase tracking-wider animate-pulse">
            {scanProgress.phase}
          </span>
        </div>
        
        <div className="absolute inset-0 rounded-full border border-phoenix/20 border-t-phoenix animate-spin-slow pointer-events-none"></div>
      </div>

      <div className="w-full max-w-xl space-y-2 text-center">
        <h3 className="text-xl font-bold text-white truncate px-4">
          {scanProgress.currentFile || 'Initializing...'}
        </h3>
        <p className="text-text-muted font-mono text-sm">
          Processed {scanProgress.current.toLocaleString()} / {scanProgress.total.toLocaleString()} files
        </p>
      </div>

      <button
        onClick={handleCancel}
        className="mt-8 flex items-center px-6 py-2 rounded-full border border-error/30 text-error hover:bg-error/10 hover:border-error transition-all duration-200 group"
      >
        <XCircle className="w-4 h-4 mr-2 group-hover:rotate-90 transition-transform" />
        <span className="font-medium text-sm">Cancel Scan</span>
      </button>
    </div>
  );
}
