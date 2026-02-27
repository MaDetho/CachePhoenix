import { useAppStore } from "@/store";
import { Sidebar } from "./Sidebar";
import ScannerPage from "@/components/scanner/ScannerPage";
import { SettingsPage } from "@/components/settings/SettingsPage";

export function AppLayout() {
  const currentPage = useAppStore((state) => state.currentPage);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-surface-0 text-text-primary selection:bg-phoenix/30 selection:text-white">
      <Sidebar />
      
      <main className="flex-1 overflow-hidden relative">
        <div className="absolute inset-0 flex flex-col scrollbar-thin scrollbar-thumb-surface-3 scrollbar-track-transparent">
          <div className={`flex-1 flex flex-col overflow-hidden ${currentPage !== "scanner" ? "hidden" : ""}`}><ScannerPage /></div>
          {currentPage === "settings" && <div className="flex-1 overflow-auto p-6"><SettingsPage /></div>}
        </div>
      </main>
    </div>
  );
}
