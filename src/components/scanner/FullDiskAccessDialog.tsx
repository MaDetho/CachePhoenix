import { useState, useEffect } from 'react';
import { ShieldAlert, ExternalLink, RefreshCw, Terminal, AlertTriangle, Copy, Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  checkFullDiskAccess,
  requestFullDiskAccess,
  getAppBinaryPath,
  type FdaProbeResult,
  type PathAccessResult,
} from '@/lib/permissions';

interface FullDiskAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when user confirms they've granted FDA and wants to retry */
  onRetry: () => void;
  /** Optional: FDA probe result with diagnostic details */
  fdaProbe?: FdaProbeResult | null;
  /** Optional: Path access test result */
  pathAccess?: PathAccessResult | null;
}

export default function FullDiskAccessDialog({
  open,
  onOpenChange,
  onRetry,
  fdaProbe,
  pathAccess,
}: FullDiskAccessDialogProps) {
  const [binaryPath, setBinaryPath] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (open) {
      getAppBinaryPath().then(setBinaryPath);
    }
  }, [open]);

  const isDevMode = binaryPath.includes('/target/debug/') || binaryPath.includes('\\target\\debug\\');
  const isEperm = fdaProbe?.error_code === 1 || pathAccess?.file_read_test?.error_code === 1;
  const isEacces = fdaProbe?.error_code === 13 || pathAccess?.file_read_test?.error_code === 13;

  const handleOpenSettings = async () => {
    await requestFullDiskAccess();
  };

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const granted = await checkFullDiskAccess();
      if (granted) {
        onOpenChange(false);
        onRetry();
      }
    } finally {
      setRetrying(false);
    }
    // If still not granted, dialog stays open — user can try again
  };

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(binaryPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard may not be available */ }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center space-x-3 mb-2">
            <div className="p-2.5 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
              <ShieldAlert className="w-6 h-6 text-yellow-400" />
            </div>
            <DialogTitle className="text-xl">Full Disk Access Required</DialogTitle>
          </div>
          <DialogDescription className="text-sm leading-relaxed">
            macOS restricts apps from reading other applications' cached data.
            To scan and recover media from Discord, Chrome, Brave, or other browsers,
            this app needs <span className="text-text-primary font-medium">Full Disk Access</span> permission.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* Instructions */}
          <div className="rounded-lg bg-surface-1 border border-border-subtle p-4 space-y-3">
            <p className="text-sm font-medium text-text-primary">How to grant access:</p>
            <ol className="text-sm text-text-muted space-y-2 list-decimal list-inside">
              <li>
                Click <span className="text-text-primary font-medium">"Open Settings"</span> below
              </li>
              <li>
                Find <span className="text-text-primary font-medium">CachePhoenix</span> in the list
                {isDevMode && (
                  <span className="text-yellow-400"> (or click + and browse to the binary below)</span>
                )}
              </li>
              <li>
                Toggle the switch <span className="text-text-primary font-medium">ON</span>
              </li>
              <li>
                <span className="text-text-primary font-medium">Restart the app</span> (FDA takes effect after restart)
              </li>
              <li>
                Come back here and click <span className="text-text-primary font-medium">"I've Granted Access"</span>
              </li>
            </ol>
          </div>

          {/* Binary path display */}
          {binaryPath && (
            <div className="rounded-lg bg-surface-1 border border-border-subtle p-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium text-text-muted flex items-center gap-1.5">
                  <Terminal className="w-3.5 h-3.5" />
                  Binary that needs FDA:
                </span>
                <button
                  onClick={handleCopyPath}
                  className="text-xs text-text-muted hover:text-text-primary transition-colors flex items-center gap-1"
                >
                  {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <code className="text-xs font-mono text-text-primary break-all leading-relaxed block">
                {binaryPath}
              </code>
            </div>
          )}

          {/* Dev mode warning */}
          {isDevMode && (
            <div className="rounded-lg bg-yellow-500/5 border border-yellow-500/20 p-3 flex gap-2.5">
              <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
              <div className="text-xs text-text-muted leading-relaxed space-y-1.5">
                <p className="text-yellow-400 font-medium">Development mode detected</p>
                <p>
                  In <code className="text-text-primary">tauri dev</code>, macOS may see your <strong>Terminal app</strong> as
                  the "responsible process" instead of the Tauri binary. Try:
                </p>
                <ul className="list-disc list-inside space-y-1 ml-1">
                  <li>Grant FDA to <strong>Terminal.app</strong> (or iTerm2/Warp/etc.) instead</li>
                  <li>Or use <code className="text-text-primary">tauri build</code> and run the built <code>.app</code> bundle</li>
                  <li>Each rebuild may invalidate the FDA grant (ad-hoc signing changes the identity)</li>
                </ul>
              </div>
            </div>
          )}

          {/* Diagnostic info when there's an error */}
          {(isEperm || isEacces) && (
            <div className="rounded-lg bg-red-500/5 border border-red-500/20 p-3">
              <p className="text-xs text-text-muted leading-relaxed">
                <span className="text-red-400 font-medium">Diagnostic: </span>
                {isEperm && (
                  <>
                    Error <code className="text-text-primary">EPERM (errno 1)</code> — This is a TCC/FDA denial.
                    macOS is actively blocking file reads. The correct binary needs FDA.
                  </>
                )}
                {isEacces && !isEperm && (
                  <>
                    Error <code className="text-text-primary">EACCES (errno 13)</code> — This is a POSIX permission denial,
                    not a macOS FDA issue. The cache files may have restrictive ownership/permissions.
                    Try checking file permissions with <code className="text-text-primary">ls -la</code> on the cache directory.
                  </>
                )}
              </p>
            </div>
          )}

          <p className="text-xs text-text-muted/70 leading-relaxed">
            This permission lets the app read cache files stored in protected directories. 
            It does not give access to your personal files or data beyond what's needed for recovery.
          </p>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <button
            onClick={() => onOpenChange(false)}
            className="px-4 py-2.5 rounded-lg text-sm font-medium text-text-muted hover:text-text-primary hover:bg-surface-3 transition-all"
          >
            Skip for now
          </button>
          <button
            onClick={handleOpenSettings}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-surface-3 hover:bg-surface-3/80 text-text-primary transition-all border border-border-subtle"
          >
            <ExternalLink className="w-4 h-4" />
            Open Settings
          </button>
          <button
            onClick={handleRetry}
            disabled={retrying}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold bg-phoenix hover:bg-phoenix-hover text-white transition-all shadow-lg shadow-phoenix/20 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${retrying ? 'animate-spin' : ''}`} />
            I've Granted Access
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
