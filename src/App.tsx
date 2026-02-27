import { Toaster } from "sonner";
import { AppLayout } from "@/components/layout/AppLayout";

export function App() {
  return (
    <>
      <AppLayout />
      <Toaster 
        theme="dark" 
        position="bottom-right" 
        toastOptions={{
          className: "bg-surface-1 border border-border-subtle text-text-primary",
        }}
      />
    </>
  );
}
