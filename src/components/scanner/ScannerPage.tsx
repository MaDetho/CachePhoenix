import { useEffect, useRef } from 'react';
import { useAppStore } from '@/store';
import { Check } from 'lucide-react';
import type { ScannerStep } from '@/types';
import CacheFolderSelect from './CacheFolderSelect';
import ScanProgress from './ScanProgress';
import ScanResults from './ScanResults';
import RecoveryConfig from './RecoveryConfig';
import RecoveryProgress from './RecoveryProgress';

const steps: { id: ScannerStep; label: string }[] = [
  { id: 'select', label: 'Select Cache' },
  { id: 'scanning', label: 'Scanning' },
  { id: 'results', label: 'Results' },
  { id: 'recovery', label: 'Recovery' },
  { id: 'complete', label: 'Complete' },
];

export default function ScannerPage() {
  const scannerStep = useAppStore((state) => state.scannerStep);
  
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [scannerStep]);

  const renderStep = () => {
    switch (scannerStep) {
      case 'select':
        return <CacheFolderSelect />;
      case 'scanning':
        return <ScanProgress />;
      case 'results':
        return <ScanResults />;
      case 'recovery':
        return <RecoveryConfig />;
      case 'complete':
        return <RecoveryProgress />;
      default:
        return <CacheFolderSelect />;
    }
  };

  const getStepStatus = (stepId: ScannerStep) => {
    const stepIndex = steps.findIndex((s) => s.id === stepId);
    const currentIndex = steps.findIndex((s) => s.id === scannerStep);

    if (stepIndex < currentIndex) return 'completed';
    if (stepIndex === currentIndex) return 'active';
    return 'pending';
  };

  return (
    <div className="flex flex-col h-full w-full bg-surface-0 text-text-primary animate-fade-in relative overflow-hidden">
        {/* Background ambient effects */}
        <div className="fixed top-0 left-0 w-full h-full pointer-events-none overflow-hidden z-0">
            <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-phoenix/10 blur-[120px] rounded-full mix-blend-screen animate-pulse-slow"></div>
            <div className="absolute bottom-[-20%] right-[-10%] w-[40%] h-[40%] bg-purple-500/10 blur-[100px] rounded-full mix-blend-screen animate-pulse-slow delay-1000"></div>
        </div>

      {/* Stepper Header */}
      <div className="w-full px-8 pt-4 pb-8 z-10 relative bg-surface-1/50 backdrop-blur-md border-b border-border-subtle/30 shrink-0">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center justify-between w-full relative">
            {/* Connecting Line Base */}
            <div className="absolute left-0 top-1/2 w-full h-0.5 bg-surface-3 -z-10 transform -translate-y-1/2 rounded-full"></div>
            
            {/* Active Progress Line */}
            <div 
              className="absolute left-0 top-1/2 h-0.5 bg-gradient-to-r from-phoenix to-amber-400 -z-10 transform -translate-y-1/2 rounded-full transition-all duration-500 ease-out"
              style={{
                width: `${(steps.findIndex(s => s.id === scannerStep) / (steps.length - 1)) * 100}%`
              }}
            ></div>

            {steps.map((step, index) => {
              const status = getStepStatus(step.id);
              
              return (
                <div key={step.id} className="flex flex-col items-center relative group cursor-default">
                  <div 
                    className={`
                      w-10 h-10 rounded-full flex items-center justify-center border-2 transition-all duration-300 z-10
                      ${status === 'completed' 
                        ? 'bg-success border-success text-white shadow-[0_0_15px_rgba(34,197,94,0.4)] scale-100' 
                        : status === 'active' 
                          ? 'bg-surface-1 border-phoenix text-phoenix shadow-[0_0_20px_rgba(255,107,53,0.5)] scale-110' 
                          : 'bg-surface-1 border-surface-3 text-text-muted hover:border-text-muted/50'
                      }
                    `}
                  >
                    {status === 'completed' ? (
                      <Check className="w-5 h-5 animate-scale-in" />
                    ) : (
                      <span className={`text-sm font-bold ${status === 'active' ? 'animate-pulse' : ''}`}>
                        {index + 1}
                      </span>
                    )}
                  </div>
                  
                  <div className={`
                    absolute top-12 whitespace-nowrap text-xs font-medium tracking-wide transition-all duration-300
                    ${status === 'active' ? 'text-phoenix translate-y-0 opacity-100' : 
                      status === 'completed' ? 'text-text-primary translate-y-0 opacity-80' : 
                      'text-text-muted translate-y-1 opacity-60'}
                  `}>
                    {step.label}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div ref={contentRef} className="flex-1 min-h-0 w-full max-w-6xl mx-auto px-6 py-6 z-10 relative flex flex-col overflow-hidden">
        <div className="w-full animate-slide-up flex-1 min-h-0 flex flex-col">
            {renderStep()}
        </div>
      </div>
    </div>
  );
}
