import { useAppStore } from "@/store";
import { cn } from "@/lib/utils";
import {
  Search,
  Settings,
} from "lucide-react";

interface SidebarItemProps {
  icon: React.ElementType;
  label: string;
  isActive: boolean;
  onClick: () => void;
  badge?: "scanning" | "recovering";
}

function SidebarItem({ icon: Icon, label, isActive, onClick, badge }: SidebarItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative flex items-center justify-center w-12 h-12 transition-all duration-200",
        isActive
          ? "bg-phoenix text-white rounded-2xl shadow-lg shadow-phoenix/20"
          : "bg-surface-3 text-text-muted hover:bg-surface-hover hover:text-text-primary rounded-[24px] hover:rounded-2xl"
      )}
      title={label}
    >
      <Icon size={24} strokeWidth={isActive ? 2.5 : 2} className="transition-transform duration-200 group-hover:scale-110" />

      <div className={cn(
        "absolute left-0 top-1/2 -translate-y-1/2 w-1 bg-white rounded-r-full transition-all duration-200",
        isActive ? "h-8 opacity-100" : "h-2 opacity-0 group-hover:opacity-100 group-hover:h-5",
        "-ml-3"
      )} />

      {badge && (
        <span className="absolute -top-1 -right-1 flex h-3 w-3">
          <span className={cn(
            "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
            badge === "scanning" ? "bg-success" : "bg-info"
          )}></span>
          <span className={cn(
            "relative inline-flex rounded-full h-3 w-3 border-2 border-surface-1",
            badge === "scanning" ? "bg-success" : "bg-info"
          )}></span>
        </span>
      )}
    </button>
  );
}

export function Sidebar() {
  const currentPage = useAppStore(state => state.currentPage);
  const setCurrentPage = useAppStore(state => state.setCurrentPage);
  const isScanning = useAppStore(state => state.isScanning);
  const isRecovering = useAppStore(state => state.isRecovering);

  const getScannerBadge = () => {
    if (isRecovering) return "recovering";
    if (isScanning) return "scanning";
    return undefined;
  };

  return (
    <aside className="flex flex-col items-center w-[72px] h-full py-3 bg-surface-1 border-r border-border-subtle shrink-0 z-50">
      <div className="mb-3">
        <div className="flex items-center justify-center w-12 h-12 bg-phoenix/10 rounded-2xl text-phoenix hover:bg-phoenix hover:text-white transition-colors duration-300 cursor-default overflow-hidden">
          <img src="/app-icon.svg" alt="Logo" className="w-8 h-8" />
        </div>
      </div>

      <div className="w-8 h-[2px] bg-surface-3 rounded-full mb-3" />

      <nav className="flex flex-col gap-2 w-full items-center">
        <SidebarItem
          icon={Search}
          label="Scanner"
          isActive={currentPage === "scanner"}
          onClick={() => setCurrentPage("scanner")}
          badge={getScannerBadge()}
        />
      </nav>

      <div className="mt-auto flex flex-col gap-2 items-center w-full">
        <div className="w-8 h-[2px] bg-surface-3 rounded-full mb-1" />

        <SidebarItem
          icon={Settings}
          label="Settings"
          isActive={currentPage === "settings"}
          onClick={() => setCurrentPage("settings")}
        />
      </div>
    </aside>
  );
}
