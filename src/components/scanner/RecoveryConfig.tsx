import { useEffect } from 'react';
import { useAppStore } from '@/store';
import { open } from '@tauri-apps/plugin-dialog';
import { homeDir, join } from '@tauri-apps/api/path';
import { formatBytes } from '@/lib/utils';
import { 
  FolderOpen, 
  Settings, 
  ChevronRight, 
  Image as ImageIcon, 
  Film, 
  FileText,
  ToggleLeft,
  ToggleRight
} from 'lucide-react';
import type { RecoveryOptions } from '@/types';

export default function RecoveryConfig() {
  const { 
    resources, 
    recoveryOptions, 
    setRecoveryOptions, 
    setScannerStep, 
    setIsRecovering 
  } = useAppStore();
  useEffect(() => {
    const setDefaultOutput = async () => {
      if (!recoveryOptions.outputFolder) {
        try {
          const home = await homeDir();
          const defaultPath = await join(home, 'CachePhoenix');
          setRecoveryOptions({ outputFolder: defaultPath });
        } catch (e) {
          console.error('Failed to resolve default output folder', e);
        }
      }
    };
    setDefaultOutput();
  }, []);

  const selectedResources = resources.filter(r => r.selected);
  const imageCount = selectedResources.filter(r => r.mediaCategory === 'image').length;
  const videoCount = selectedResources.filter(r => r.mediaCategory === 'video').length;
  const audioCount = selectedResources.filter(r => r.mediaCategory === 'audio').length;
  const otherCount = selectedResources.filter(r => r.mediaCategory === 'other').length;

  const handleSelectOutputFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Recovery Output Folder',
      });

      if (selected && typeof selected === 'string') {
        setRecoveryOptions({ ...recoveryOptions, outputFolder: selected });
      }
    } catch (e) {
      console.error('Failed to select output folder', e);
    }
  };

  const toggleOption = (key: keyof RecoveryOptions) => {
    if (key === 'outputFolder') return;
    setRecoveryOptions({
      ...recoveryOptions,
      [key]: !recoveryOptions[key]
    });
  };

  const handleStartRecovery = () => {
    if (recoveryOptions.outputFolder) {
      setIsRecovering(true);
      setScannerStep('complete');
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 max-w-4xl mx-auto animate-fade-in">
      <div className="flex-1 min-h-0 overflow-y-auto space-y-6 p-4 pb-8">
      <div className="text-center space-y-2">
        <h2 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-text-muted">
          Recovery Configuration
        </h2>
        <p className="text-text-muted">
          Configure how your recovered files will be saved and processed.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-6">
          <div className="bg-surface-1/50 border border-surface-2 rounded-xl p-6 space-y-4 backdrop-blur-sm">
            <h3 className="text-lg font-bold flex items-center">
              <FolderOpen className="w-5 h-5 mr-2 text-phoenix" />
              Output Location
            </h3>
            
            <div className="space-y-2">
              <label className="text-sm text-text-muted">Save recovered files to:</label>
              <div className="flex space-x-2">
                <div className="flex-1 bg-surface-3/50 border border-surface-3 rounded-lg px-3 py-2 text-sm font-mono truncate text-text-muted">
                  {recoveryOptions.outputFolder || 'No folder selected'}
                </div>
                <button
                  onClick={handleSelectOutputFolder}
                  className="px-4 py-2 bg-surface-2 hover:bg-surface-3 text-text-primary rounded-lg font-medium transition-colors border border-surface-3 hover:border-text-muted/30"
                >
                  Browse
                </button>
              </div>
            </div>
            
            <div className="pt-4 border-t border-surface-2">
               <div className="flex items-center justify-between text-sm text-text-muted">
                 <span>Free Space Required:</span>
                  <span className="font-mono text-text-primary">~{formatBytes(selectedResources.reduce((acc, r) => acc + r.totalSize, 0))}</span>
               </div>
            </div>
          </div>

          <div className="bg-surface-1/50 border border-surface-2 rounded-xl p-6 space-y-4 backdrop-blur-sm">
            <h3 className="text-lg font-bold flex items-center">
              <FileText className="w-5 h-5 mr-2 text-phoenix" />
              Summary
            </h3>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-surface-2/50 rounded-lg p-3 text-center">
                <ImageIcon className="w-5 h-5 mx-auto mb-1 text-blue-400" />
                <div className="text-lg font-bold">{imageCount}</div>
                <div className="text-xs text-text-muted">Images</div>
              </div>
              <div className="bg-surface-2/50 rounded-lg p-3 text-center">
                <Film className="w-5 h-5 mx-auto mb-1 text-red-400" />
                <div className="text-lg font-bold">{videoCount}</div>
                <div className="text-xs text-text-muted">Videos</div>
              </div>
              <div className="bg-surface-2/50 rounded-lg p-3 text-center">
                <div className="text-lg font-bold">{audioCount}</div>
                <div className="text-xs text-text-muted">Audio</div>
              </div>
              <div className="bg-surface-2/50 rounded-lg p-3 text-center">
                <div className="text-lg font-bold">{otherCount}</div>
                <div className="text-xs text-text-muted">Other</div>
              </div>
            </div>
            
            <div className="text-center pt-2">
              <span className="text-sm font-medium text-text-primary">
                Total: {selectedResources.length} files
              </span>
            </div>
          </div>
        </div>

        <div className="bg-surface-1/50 border border-surface-2 rounded-xl p-6 space-y-6 backdrop-blur-sm">
          <h3 className="text-lg font-bold flex items-center">
            <Settings className="w-5 h-5 mr-2 text-phoenix" />
            Processing Options
          </h3>
          
          <div className="space-y-4">
            <OptionToggle
              label="Organize by type"
              description="Create subfolders for images, videos, and audio"
              checked={recoveryOptions.organizeByType}
              onChange={() => toggleOption('organizeByType')}
            />
            
            <OptionToggle
              label="Convert WebM to MP4"
              description="Convert recovered WebM videos to MP4 format"
              checked={recoveryOptions.convertWebmToMp4}
              onChange={() => toggleOption('convertWebmToMp4')}
            />
            
            <OptionToggle
              label="Convert GIF to MP4"
              description="Convert animated GIFs to MP4 video"
              checked={recoveryOptions.convertGifToMp4}
              onChange={() => toggleOption('convertGifToMp4')}
            />
            
            <OptionToggle
              label="Generate thumbnails"
              description="Create thumbnail images for videos"
              checked={recoveryOptions.generateThumbnails}
              onChange={() => toggleOption('generateThumbnails')}
            />

            <OptionToggle
              label="Concatenate selected videos"
              description="Merge all selected videos into a single file in chronological order"
              checked={recoveryOptions.concatenateVideos}
              onChange={() => toggleOption('concatenateVideos')}
            />
            {recoveryOptions.concatenateVideos && (
              <p className="text-xs text-amber-400/80 px-3 -mt-2">
                ⚠ Works best with segments from the same stream. Videos are joined by timestamp.
              </p>
            )}

          </div>
      </div>
      </div>
      </div>
      <div className="shrink-0 flex justify-end p-4 border-t border-surface-2">
        <button
          onClick={handleStartRecovery}
          disabled={!recoveryOptions.outputFolder}
          className={`
            flex items-center px-10 py-4 rounded-xl font-bold text-lg transition-all duration-300 shadow-lg w-full md:w-auto justify-center
            ${recoveryOptions.outputFolder 
              ? 'bg-phoenix hover:bg-phoenix-hover text-white shadow-phoenix/30 hover:shadow-phoenix/50 transform hover:-translate-y-0.5' 
              : 'bg-surface-3 text-text-muted cursor-not-allowed'
            }
          `}
        >
          <span>Start Recovery</span>
          <ChevronRight className="w-6 h-6 ml-2" />
        </button>
      </div>
    </div>
  );
}

function OptionToggle({ 
  label, 
  description, 
  checked, 
  onChange 
}: { 
  label: string; 
  description: string; 
  checked: boolean; 
  onChange: () => void; 
}) {
  return (
    <div 
      onClick={onChange}
      className="flex items-center justify-between p-3 rounded-lg hover:bg-surface-2 cursor-pointer group transition-colors"
    >
      <div className="flex flex-col space-y-1">
        <span className="font-medium text-text-primary group-hover:text-white transition-colors">{label}</span>
        <span className="text-xs text-text-muted">{description}</span>
      </div>
      
      <div className={`transition-colors duration-200 ${checked ? 'text-phoenix' : 'text-surface-3'}`}>
        {checked ? <ToggleRight className="w-10 h-10" /> : <ToggleLeft className="w-10 h-10" />}
      </div>
    </div>
  );
}



