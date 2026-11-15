import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  UploadIcon,
  FileTextIcon,
  DownloadIcon,
  Wand2Icon,
  RotateCcwIcon,
  Trash2Icon,
  SquareIcon,
  CheckCircle2Icon,
  SubtitlesIcon,
  LayersIcon,
  Loader2Icon,
  MinusIcon,
  PlusIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { WorkspaceHeader } from '@/components/app-shell/workspace-header';
import { Button } from '@/components/ui/button';
import { WaveformPlayer } from '@/components/waveform-player';
import { AudioPreviewButton } from '@/components/audio-preview-button';
// Shared application controls are JavaScript; keep their established voice/value contracts.
// @ts-expect-error shared JSX component has no declaration file
import VoiceSelector from '@shared/components/VoiceSelector';
// @ts-expect-error shared JSX component has no declaration file
import SearchableSelect from '@shared/components/SearchableSelect';
import { useProfiles } from '@/hooks/use-profiles';
import { generateClone } from '@/lib/api/generate';
import { cloneSettingsStore } from '@/lib/store/clone-settings';
import { apiFetch, apiJson, apiPath, describeError } from '@/lib/api/client';
import { saveLocalFile } from '@/lib/local-export';
import { formatTimestamp } from '@shared/utils/timeFormat';
import { cn } from '@/lib/utils';

export interface SrtCue {
  id: number;
  start: number;
  end: number;
  duration: number;
  text: string;
  speaker_id?: string;
  voiceId?: string;
  audio_url?: string;
  isGenerating?: boolean;
}

interface SrtParseResponse {
  filename: string;
  cues: SrtCue[];
  total_duration: number;
  total_cues: number;
}

interface AssembleResponse {
  audio_url: string;
  duration: number;
  filename: string;
}

function toPlayableUrl(url?: string | null): string {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('blob:')) {
    return url;
  }
  return apiPath(url);
}

function formatSrtTimestamp(seconds: number): string {
  const s = Math.max(0, seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const millis = Math.round((s % 1) * 1000);

  const hh = String(hrs).padStart(2, '0');
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  const mmm = String(millis).padStart(3, '0');

  return `${hh}:${mm}:${ss},${mmm}`;
}

function generateSrtContent(cues: SrtCue[]): string {
  return cues
    .map((cue, idx) => {
      const startStr = formatSrtTimestamp(cue.start);
      const endStr = formatSrtTimestamp(cue.end);
      return `${idx + 1}\n${startStr} --> ${endStr}\n${cue.text}\n`;
    })
    .join('\n');
}

export function SubtitlesPage() {
  const { t } = useTranslation();
  const profiles = useProfiles();
  const availableProfiles = Array.isArray(profiles.data) ? profiles.data : [];

  const [filename, setFilename] = useState<string>('');
  const [cues, setCues] = useState<SrtCue[]>([]);
  const [totalDuration, setTotalDuration] = useState<number>(0);
  const [voiceId, setVoiceId] = useState<string>('');
  const [timingMode, setTimingMode] = useState<'strict_fit' | 'natural'>('strict_fit');
  const [baseSeed] = useState<number>(42);

  // Automatically select the first available voice profile when loaded
  useEffect(() => {
    if (!voiceId && availableProfiles.length > 0) {
      setVoiceId(availableProfiles[0].id);
    }
  }, [availableProfiles, voiceId]);

  const [isParsing, setIsParsing] = useState(false);
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  const [isAssembling, setIsAssembling] = useState(false);

  const [assembledAudioUrl, setAssembledAudioUrl] = useState<string | null>(null);
  const [assembledDuration, setAssembledDuration] = useState<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleFileChange = useCallback(
    async (file: File) => {
      if (!file) return;
      setIsParsing(true);
      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await apiJson<SrtParseResponse>('/srt/parse', {
          method: 'POST',
          body: formData,
        });

        setFilename(res.filename);
        setCues(res.cues);
        setTotalDuration(res.total_duration);
        setAssembledAudioUrl(null);
        setAssembledDuration(null);
        toast.success(t('srtVoice.cues_count', { count: res.total_cues }));
      } catch (err) {
        toast.error(describeError(err));
      } finally {
        setIsParsing(false);
      }
    },
    [t],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        const file = files[0];
        if (file.name.toLowerCase().endsWith('.srt')) {
          handleFileChange(file);
        } else {
          toast.error(t('srtVoice.choose_file'));
        }
      }
    },
    [handleFileChange, t],
  );

  const handleCueTextChange = (id: number, text: string) => {
    setCues((prev) => prev.map((c) => (c.id === id ? { ...c, text } : c)));
  };

  const handleCueVoiceChange = (id: number, val: string) => {
    setCues((prev) => prev.map((c) => (c.id === id ? { ...c, voiceId: val } : c)));
  };

  const handleDurationChange = useCallback((cueId: number, nextDuration: number) => {
    setCues((prev) => {
      const index = prev.findIndex((c) => c.id === cueId);
      if (index === -1) return prev;
      const current = prev[index];
      const safeDuration = Math.max(0.2, Math.round(nextDuration * 100) / 100);
      const newEnd = Math.round((current.start + safeDuration) * 100) / 100;
      const delta = Math.round((newEnd - current.end) * 100) / 100;

      if (delta === 0) return prev;

      const updated = prev.map((c, idx) => {
        if (idx < index) return c;
        if (idx === index) {
          return {
            ...c,
            end: newEnd,
            duration: safeDuration,
          };
        }
        return {
          ...c,
          start: Math.max(0, Math.round((c.start + delta) * 100) / 100),
          end: Math.max(0.1, Math.round((c.end + delta) * 100) / 100),
        };
      });

      const lastCue = updated[updated.length - 1];
      if (lastCue) {
        setTotalDuration(lastCue.end);
      }
      return updated;
    });
  }, []);

  const generateSingleCue = useCallback(
    async (cue: SrtCue, signal?: AbortSignal) => {
      if (!cue.text.trim()) return;
      const settings = cloneSettingsStore.state;
      const targetVoice = cue.voiceId || voiceId;
      const isPreset = targetVoice.startsWith('preset:');
      const profileId = isPreset || !targetVoice ? undefined : targetVoice;
      const presetVoice = isPreset ? targetVoice.slice(7) : undefined;
      const profile = availableProfiles.find((p) => p.id === profileId);
      const seed =
        profile?.seed != null && Number.isInteger(profile.seed)
          ? profile.seed
          : baseSeed;

      const result = await generateClone(
        {
          ...settings,
          text: cue.text.trim(),
          profileId,
          presetVoice,
          seed,
        },
        { signal },
      );

      if (result.audioPath) {
        const generatedUrl = `/audio/${result.audioPath}`;
        setCues((prev) =>
          prev.map((c) => (c.id === cue.id ? { ...c, audio_url: generatedUrl, isGenerating: false } : c)),
        );
      }
    },
    [availableProfiles, baseSeed, voiceId],
  );

  const handleGenerateCue = useCallback(
    async (cue: SrtCue) => {
      setCues((prev) => prev.map((c) => (c.id === cue.id ? { ...c, isGenerating: true } : c)));
      try {
        await generateSingleCue(cue);
      } catch (err) {
        toast.error(describeError(err));
      } finally {
        setCues((prev) => prev.map((c) => (c.id === cue.id ? { ...c, isGenerating: false } : c)));
      }
    },
    [generateSingleCue],
  );

  const handleGenerateAll = useCallback(async () => {
    if (cues.length === 0) return;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsGeneratingAll(true);
    setProgress({ current: 0, total: cues.length });

    try {
      for (let i = 0; i < cues.length; i++) {
        if (controller.signal.aborted) break;
        const cue = cues[i];
        setProgress({ current: i + 1, total: cues.length });
        setCues((prev) => prev.map((c) => (c.id === cue.id ? { ...c, isGenerating: true } : c)));

        try {
          await generateSingleCue(cue, controller.signal);
        } catch (err) {
          if (controller.signal.aborted) break;
          toast.error(`Cue #${cue.id}: ${describeError(err)}`);
        } finally {
          setCues((prev) => prev.map((c) => (c.id === cue.id ? { ...c, isGenerating: false } : c)));
        }
      }
      if (!controller.signal.aborted) {
        toast.success(t('srtVoice.ready_to_export'));
      }
    } finally {
      setIsGeneratingAll(false);
      abortControllerRef.current = null;
    }
  }, [cues, generateSingleCue, t]);

  const handleStop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsGeneratingAll(false);
    }
  }, []);

  const handleAssemble = useCallback(async () => {
    const readyCues = cues.filter((c) => Boolean(c.audio_url));
    if (readyCues.length === 0) {
      toast.error(t('srtVoice.no_audio_yet'));
      return;
    }

    setIsAssembling(true);
    try {
      const payload = {
        cues: readyCues.map((c) => ({
          id: c.id,
          start: c.start,
          end: c.end,
          audio_url: c.audio_url!,
        })),
        timing_mode: timingMode,
        total_duration: totalDuration,
      };

      const res = await apiJson<AssembleResponse>('/srt/assemble', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      setAssembledAudioUrl(res.audio_url);
      setAssembledDuration(res.duration);
      toast.success(t('srtVoice.play_all'));
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setIsAssembling(false);
    }
  }, [cues, timingMode, totalDuration, t]);

  const handleDownload = useCallback(async () => {
    if (!assembledAudioUrl) return;
    try {
      const res = await apiFetch(assembledAudioUrl);
      const blob = await res.blob();
      const base = filename ? filename.replace(/\.[^/.]+$/, '') : 'subtitles';
      await saveLocalFile(blob, `${base}_voice.wav`);
    } catch (err) {
      toast.error(describeError(err));
    }
  }, [assembledAudioUrl, filename]);

  const handleExportSrt = useCallback(async () => {
    if (cues.length === 0) return;
    try {
      const content = generateSrtContent(cues);
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const base = filename ? filename.replace(/\.[^/.]+$/, '') : 'subtitles';
      await saveLocalFile(blob, `${base}_adjusted.srt`);
      toast.success(t('srtVoice.export_srt'));
    } catch (err) {
      toast.error(describeError(err));
    }
  }, [cues, filename, t]);

  const handleClear = () => {
    handleStop();
    setFilename('');
    setCues([]);
    setTotalDuration(0);
    setAssembledAudioUrl(null);
    setAssembledDuration(null);
  };

  const completedCount = cues.filter((c) => Boolean(c.audio_url)).length;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <WorkspaceHeader>
        <div className="flex items-center gap-2">
          <SubtitlesIcon className="size-4 text-primary" />
          <h1 className="text-sm font-medium">{t('srtVoice.title')}</h1>
        </div>
        <p className="hidden text-xs text-muted-foreground sm:block">
          {t('srtVoice.subtitle')}
        </p>

        {filename && (
          <div className="ms-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportSrt}
              className="text-xs"
            >
              <DownloadIcon className="mr-1 size-3.5" />
              {t('srtVoice.export_srt')}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleClear} className="text-xs">
              <Trash2Icon className="mr-1 size-3.5" />
              {t('srtVoice.clear')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="text-xs"
            >
              <RotateCcwIcon className="mr-1 size-3.5" />
              {t('srtVoice.change_file')}
            </Button>
          </div>
        )}
      </WorkspaceHeader>

      <input
        ref={fileInputRef}
        type="file"
        accept=".srt"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFileChange(f);
          e.target.value = '';
        }}
      />

      {cues.length === 0 ? (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          className="m-6 flex flex-1 flex-col items-center justify-center rounded-xl border-2 border-dashed border-border/70 p-8 text-center transition-colors hover:border-primary/50"
        >
          <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <UploadIcon className="size-7" />
          </div>
          <h2 className="mb-1 text-base font-semibold">{t('srtVoice.upload_title')}</h2>
          <p className="mb-5 max-w-md text-xs text-muted-foreground">
            {t('srtVoice.upload_desc')}
          </p>
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={isParsing}
            className="gap-2"
          >
            <FileTextIcon className="size-4" />
            {isParsing ? '...' : t('srtVoice.choose_file')}
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Controls Bar */}
          <div className="flex flex-wrap items-center gap-3 border-b border-border/60 bg-card/40 px-4 py-2.5">
            <div className="w-64">
              <VoiceSelector
                value={voiceId}
                onChange={(val: string) => setVoiceId(val)}
                profiles={availableProfiles}
                presets={true}
                gallery={true}
                engineDefault={true}
                ariaLabel={t('srtVoice.voice_label')}
              />
            </div>

            <div className="w-56">
              <SearchableSelect
                value={timingMode}
                onChange={(val: string) => setTimingMode(val as 'strict_fit' | 'natural')}
                options={[
                  { value: 'strict_fit', label: t('srtVoice.strict_fit') },
                  { value: 'natural', label: t('srtVoice.natural') },
                ]}
                ariaLabel={t('srtVoice.timing_mode')}
              />
            </div>

            <div className="flex items-center gap-2">
              {isGeneratingAll ? (
                <Button variant="destructive" size="sm" onClick={handleStop} className="gap-1.5">
                  <SquareIcon className="size-3.5 fill-current" />
                  {t('srtVoice.generating', { current: progress.current, total: progress.total })}
                </Button>
              ) : (
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleGenerateAll}
                  disabled={isAssembling}
                  className="gap-1.5"
                >
                  <Wand2Icon className="size-3.5" />
                  {t('srtVoice.generate_all')}
                </Button>
              )}

              <Button
                variant="secondary"
                size="sm"
                onClick={handleAssemble}
                disabled={completedCount === 0 || isGeneratingAll || isAssembling}
                className="gap-1.5"
              >
                <LayersIcon className="size-3.5" />
                {isAssembling ? t('srtVoice.assembling') : t('srtVoice.assemble_track')}
              </Button>
            </div>

            <div className="ms-auto flex items-center gap-4 text-xs text-muted-foreground">
              <span>{t('srtVoice.cues_count', { count: cues.length })}</span>
              <span>•</span>
              <span>
                {t('srtVoice.total_duration', {
                  duration: `${totalDuration.toFixed(1)}s`,
                })}
              </span>
              <span>•</span>
              <span className="font-medium text-foreground">
                {completedCount}/{cues.length} {t('srtVoice.cue_generated').toLowerCase()}
              </span>
            </div>
          </div>

          {/* Assembled Audio Player Card */}
          {assembledAudioUrl && (
            <div className="border-b border-border/60 bg-primary/5 p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-primary">
                    <CheckCircle2Icon className="size-4" />
                    <span>{t('srtVoice.play_all')}</span>
                    {assembledDuration && (
                      <span className="text-muted-foreground">
                        ({assembledDuration.toFixed(1)}s)
                      </span>
                    )}
                  </div>
                  <WaveformPlayer
                    src={toPlayableUrl(assembledAudioUrl)}
                    source="srt-assembled"
                    height={36}
                  />
                </div>
                <Button
                  onClick={handleDownload}
                  variant="default"
                  size="sm"
                  className="shrink-0 gap-1.5"
                >
                  <DownloadIcon className="size-4" />
                  {t('srtVoice.download_audio')}
                </Button>
              </div>
            </div>
          )}

          {/* Cues List */}
          <div className="studio-scrollbar flex-1 overflow-y-auto p-4">
            <div className="space-y-2">
              {cues.map((cue) => {
                const startTime = formatTimestamp(cue.start, { decimals: 2 });
                const endTime = formatTimestamp(cue.end, { decimals: 2 });

                return (
                  <div
                    key={cue.id}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border border-border/60 bg-card p-3 transition-colors',
                      cue.isGenerating && 'border-primary/50 bg-primary/[0.02]',
                      cue.audio_url && 'border-emerald-500/30 dark:border-emerald-500/20',
                    )}
                  >
                    {/* Index & Timing */}
                    <div className="w-56 shrink-0 space-y-1.5">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                        <span>{t('srtVoice.cue_title', { id: cue.id })}</span>
                        {cue.audio_url && (
                          <CheckCircle2Icon className="size-3.5 text-emerald-500" />
                        )}
                        <span className="ms-auto text-[11px] font-normal tabular-nums text-muted-foreground">
                          {startTime} → {endTime}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="icon-xs"
                          onClick={() => handleDurationChange(cue.id, cue.duration - 0.5)}
                          disabled={cue.duration <= 0.3}
                          title="-0.5s"
                          aria-label="Decrease duration 0.5s"
                          className="size-6 text-xs"
                        >
                          <MinusIcon className="size-3" />
                        </Button>
                        <div className="relative flex items-center">
                          <input
                            type="number"
                            min="0.2"
                            step="0.1"
                            value={cue.duration}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value);
                              if (!isNaN(val) && val > 0) {
                                handleDurationChange(cue.id, val);
                              }
                            }}
                            className="h-6 w-16 rounded border border-input/60 bg-background/50 px-1 text-center font-mono text-[11px] tabular-nums text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          />
                          <span className="pointer-events-none absolute right-1.5 text-[10px] text-muted-foreground">
                            s
                          </span>
                        </div>
                        <Button
                          variant="outline"
                          size="icon-xs"
                          onClick={() => handleDurationChange(cue.id, cue.duration + 0.5)}
                          title="+0.5s"
                          aria-label="Increase duration 0.5s"
                          className="size-6 text-xs"
                        >
                          <PlusIcon className="size-3" />
                        </Button>
                        <span className="ms-1 text-[10px] text-muted-foreground">
                          {t('srtVoice.duration_label')}
                        </span>
                      </div>
                    </div>

                    {/* Text Area */}
                    <div className="min-w-0 flex-1">
                      <input
                        type="text"
                        value={cue.text}
                        onChange={(e) => handleCueTextChange(cue.id, e.target.value)}
                        className="w-full rounded-md border border-input/60 bg-background/50 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                    </div>

                    {availableProfiles.length > 1 && (
                      <div className="w-36 shrink-0">
                        <SearchableSelect
                          value={cue.voiceId || ''}
                          onChange={(v: string) => handleCueVoiceChange(cue.id, v)}
                          options={[
                            {
                              value: '',
                              label: `↳ ${
                                availableProfiles.find((p) => p.id === voiceId)?.name ||
                                t('voiceSelector.engineDefault')
                              }`,
                            },
                            ...availableProfiles.map((p) => ({ value: p.id, label: p.name })),
                          ]}
                          menuPortal
                          ariaLabel={t('srtVoice.voice_label')}
                        />
                      </div>
                    )}

                    {/* Individual Audio Preview & Action */}
                    <div className="flex shrink-0 items-center gap-1.5">
                      {cue.audio_url ? (
                        <>
                          <AudioPreviewButton
                            src={toPlayableUrl(cue.audio_url)}
                            source={`cue-${cue.id}`}
                          />
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => handleGenerateCue(cue)}
                            disabled={cue.isGenerating || isGeneratingAll}
                            title={t('srtVoice.generate_cue')}
                            aria-label={t('srtVoice.generate_cue')}
                            className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
                          >
                            {cue.isGenerating ? (
                              <Loader2Icon className="size-4 animate-spin text-primary" />
                            ) : (
                              <RotateCcwIcon className="size-4" />
                            )}
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleGenerateCue(cue)}
                          disabled={cue.isGenerating || isGeneratingAll}
                          className="h-8 gap-1.5 px-2.5 text-xs"
                        >
                          {cue.isGenerating ? (
                            <Loader2Icon className="size-3.5 animate-spin" />
                          ) : (
                            <Wand2Icon className="size-3.5 text-primary" />
                          )}
                          <span>{t('srtVoice.generate_cue')}</span>
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
