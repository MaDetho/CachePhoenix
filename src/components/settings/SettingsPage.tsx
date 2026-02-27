import { useState, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "@/store";
import {
  Settings,
  FolderOpen,
  Monitor,
  Zap,
  HelpCircle,
  Github,
  Cpu,
  FileText
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/utils";

export function SettingsPage() {
  const settings = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion("unknown"));
  }, []);

  const handleBrowseFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Default Output Folder",
      });

      if (selected) {
        setSettings({ defaultOutputFolder: selected as string });
      }
    } catch (error) {
      console.error("Failed to open dialog:", error);
    }
  };

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-8 animate-fade-in pb-20">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight text-text-primary">Settings</h1>
        <p className="text-text-muted">Configure how CachePhoenix works</p>
      </div>

      <div className="space-y-6">
        <section className="rounded-xl border border-border-subtle bg-surface-2 p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-6 pb-4 border-b border-border-subtle">
            <div className="rounded-lg bg-surface-3 p-2">
              <Settings className="h-5 w-5 text-text-primary" />
            </div>
            <h2 className="text-lg font-semibold text-text-primary">General</h2>
          </div>

          <div className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-0.5">
                <label className="text-sm font-medium text-text-primary flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-text-muted" />
                  Max Concurrent Threads
                </label>
                <p className="text-xs text-text-muted">
                  Higher values use more CPU but scan faster (1-16)
                </p>
              </div>
              <input
                type="number"
                min={1}
                max={16}
                value={settings.maxThreads}
                onChange={(e) => setSettings({ maxThreads: Math.max(1, Math.min(16, parseInt(e.target.value) || 4)) })}
                className="w-20 rounded-md border border-border-subtle bg-surface-3 px-3 py-1.5 text-sm text-text-primary focus:border-phoenix focus:outline-none focus:ring-1 focus:ring-phoenix"
              />
            </div>

            <div className="flex flex-col gap-3">
              <div className="space-y-0.5">
                <label className="text-sm font-medium text-text-primary flex items-center gap-2">
                  <FileText className="h-4 w-4 text-text-muted" />
                  Output Naming Template
                </label>
                <p className="text-xs text-text-muted">
                  Available variables: <code className="bg-surface-3 px-1 rounded text-xs">{`{type}`}</code>, <code className="bg-surface-3 px-1 rounded text-xs">{`{index}`}</code>, <code className="bg-surface-3 px-1 rounded text-xs">{`{date}`}</code>
                </p>
              </div>
              <input
                type="text"
                value={settings.outputNamingTemplate}
                onChange={(e) => setSettings({ outputNamingTemplate: e.target.value })}
                className="w-full rounded-md border border-border-subtle bg-surface-3 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-phoenix focus:outline-none focus:ring-1 focus:ring-phoenix"
              />
            </div>

            <div className="flex flex-col gap-3">
              <div className="space-y-0.5">
                <label className="text-sm font-medium text-text-primary flex items-center gap-2">
                  <FolderOpen className="h-4 w-4 text-text-muted" />
                  Default Output Folder
                </label>
                <p className="text-xs text-text-muted">
                  Where recovered files will be saved by default
                </p>
              </div>
              <div className="flex gap-2">
                <div className="flex-1 truncate rounded-md border border-border-subtle bg-surface-3 px-3 py-2 text-sm text-text-muted">
                  {settings.defaultOutputFolder || "Not set (will ask on recovery)"}
                </div>
                <button
                  onClick={handleBrowseFolder}
                  className="shrink-0 rounded-md bg-phoenix px-4 py-2 text-sm font-semibold text-white hover:bg-phoenix-dark transition-colors"
                >
                  Browse
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border-subtle bg-surface-2 p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-6 pb-4 border-b border-border-subtle">
            <div className="rounded-lg bg-surface-3 p-2">
              <Zap className="h-5 w-5 text-text-primary" />
            </div>
            <h2 className="text-lg font-semibold text-text-primary">Behavior</h2>
          </div>

          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <label className="text-sm font-medium text-text-primary">Auto-open output folder</label>
                <p className="text-xs text-text-muted">
                  Open the folder automatically after recovery completes
                </p>
              </div>
              <button
                onClick={() => setSettings({ autoOpenOutput: !settings.autoOpenOutput })}
                className={cn(
                  "relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-phoenix focus:ring-offset-2 focus:ring-offset-surface-1",
                  settings.autoOpenOutput ? "bg-phoenix" : "bg-surface-3"
                )}
              >
                <span
                  className={cn(
                    "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                    settings.autoOpenOutput ? "translate-x-6" : "translate-x-1"
                  )}
                />
              </button>
            </div>

            <div className="flex items-center justify-between opacity-75">
              <div className="space-y-0.5">
                <label className="text-sm font-medium text-text-primary flex items-center gap-2">
                  <Monitor className="h-4 w-4 text-text-muted" />
                  Theme
                </label>
                <p className="text-xs text-text-muted">
                  Visual appearance of the application
                </p>
              </div>
              <span className="inline-flex items-center rounded-md bg-surface-3 px-3 py-1 text-xs font-medium text-text-muted border border-border-subtle cursor-not-allowed">
                Dark Mode (Default)
              </span>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border-subtle bg-surface-2 p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-6 pb-4 border-b border-border-subtle">
            <div className="rounded-lg bg-surface-3 p-2">
              <HelpCircle className="h-5 w-5 text-text-primary" />
            </div>
            <h2 className="text-lg font-semibold text-text-primary">About</h2>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-text-primary">CachePhoenix</h3>
                <p className="text-xs text-text-muted">Version {appVersion || "…"} • Created by MaDetho</p>
              </div>
              <img src="/app-icon.svg" alt="CachePhoenix Logo" className="h-10 w-10 rounded-xl shadow-sm" />
            </div>

            <p className="text-sm text-text-muted leading-relaxed">
              A powerful tool that recovers media files from Chromium-based browser caches — Discord, Chrome, Brave, Edge, Opera, and custom folders.
            </p>

            <div className="pt-4 flex gap-4 border-t border-border-subtle">
              <a href="https://github.com/MaDetho/CachePhoenix" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-xs text-text-muted hover:text-phoenix transition-colors">
                <Github className="h-4 w-4" />
                GitHub Repository
              </a>
              <a href="https://github.com/MaDetho/CachePhoenix#readme" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-xs text-text-muted hover:text-phoenix transition-colors">
                <HelpCircle className="h-4 w-4" />
                Documentation
              </a>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
