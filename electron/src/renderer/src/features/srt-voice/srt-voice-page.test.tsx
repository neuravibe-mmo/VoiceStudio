import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { SubtitlesPage } from './srt-voice-page';

const mock = vi.hoisted(() => ({
  generate: vi.fn(),
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: mock.toast }));
vi.mock('@/components/app-shell/workspace-header', () => ({
  WorkspaceHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
}));
vi.mock('@/lib/api/generate', () => ({ generateClone: mock.generate }));
vi.mock('@/lib/api/client', () => ({
  apiJson: mock.apiJson,
  apiFetch: mock.apiFetch,
  apiPath: (p: string) => p,
  audioUrl: (p: string) => `/audio/${p}`,
  describeError: (e: any) => String(e?.message || e),
}));
vi.mock('@/hooks/use-profiles', () => ({
  useProfiles: () => ({
    data: [
      { id: 'profile-1', name: 'Aria' },
      { id: 'profile-2', name: 'Roger' },
    ],
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: any) => (opts?.count ? `${key}:${opts.count}` : key),
  }),
}));
vi.mock('@/components/waveform-player', () => ({
  WaveformPlayer: ({ source }: { source: string }) => <div data-testid={source} />,
}));
vi.mock('@/components/audio-preview-button', () => ({
  AudioPreviewButton: ({ source, src }: any) => <button data-testid={source} data-src={src}>Play</button>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('renders upload dropzone initially', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SubtitlesPage />
    </QueryClientProvider>,
  );

  expect(screen.getByText('srtVoice.upload_title')).toBeInTheDocument();
  expect(screen.getByText('srtVoice.choose_file')).toBeInTheDocument();
});

it('parses srt file and displays cues', async () => {
  mock.apiJson.mockResolvedValueOnce({
    filename: 'movie.srt',
    total_cues: 2,
    total_duration: 5.5,
    cues: [
      { id: 1, start: 1.0, end: 3.0, duration: 2.0, text: 'Hello world' },
      { id: 2, start: 3.5, end: 5.5, duration: 2.0, text: 'Goodbye world' },
    ],
  });

  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <SubtitlesPage />
    </QueryClientProvider>,
  );

  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['dummy srt'], 'movie.srt', { type: 'text/plain' });

  fireEvent.change(fileInput, { target: { files: [file] } });

  await waitFor(() => {
    expect(screen.getByDisplayValue('Hello world')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Goodbye world')).toBeInTheDocument();
  });
});

it('triggers assemble when cues have audio', async () => {
  mock.apiJson
    .mockResolvedValueOnce({
      filename: 'movie.srt',
      total_cues: 1,
      total_duration: 3.0,
      cues: [{ id: 1, start: 0.0, end: 3.0, duration: 3.0, text: 'Test line' }],
    })
    .mockResolvedValueOnce({
      audio_url: '/audio/srt_assembled.wav',
      duration: 3.0,
      filename: 'srt_assembled.wav',
    });

  mock.generate.mockResolvedValueOnce({
    audioPath: 'cue_1.wav',
    blob: new Blob(['audio']),
  });

  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <SubtitlesPage />
    </QueryClientProvider>,
  );

  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [new File(['srt'], 'test.srt')] } });

  await waitFor(() => {
    expect(screen.getByDisplayValue('Test line')).toBeInTheDocument();
  });

  // Generate cue
  fireEvent.click(screen.getByRole('button', { name: 'srtVoice.generate_all' }));

  await waitFor(() => {
    expect(mock.generate).toHaveBeenCalled();
  });

  // Click assemble
  fireEvent.click(screen.getByRole('button', { name: 'srtVoice.assemble_track' }));

  await waitFor(() => {
    expect(mock.apiJson).toHaveBeenCalledWith(
      '/srt/assemble',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

it('uses consistent voice profile and seed across multiple cues', async () => {
  mock.apiJson.mockResolvedValueOnce({
    filename: 'dialogue.srt',
    total_cues: 2,
    total_duration: 6.0,
    cues: [
      { id: 1, start: 0.0, end: 3.0, duration: 3.0, text: 'First line' },
      { id: 2, start: 3.0, end: 6.0, duration: 3.0, text: 'Second line' },
    ],
  });

  mock.generate
    .mockResolvedValueOnce({ audioPath: 'c1.wav', blob: new Blob(['a']) })
    .mockResolvedValueOnce({ audioPath: 'c2.wav', blob: new Blob(['b']) });

  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <SubtitlesPage />
    </QueryClientProvider>,
  );

  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [new File(['srt'], 'dialogue.srt')] } });

  await waitFor(() => {
    expect(screen.getByDisplayValue('First line')).toBeInTheDocument();
  });

  fireEvent.click(screen.getByRole('button', { name: 'srtVoice.generate_all' }));

  await waitFor(() => {
    expect(mock.generate).toHaveBeenCalledTimes(2);
  });

  // Verify both calls used the same profileId and seed
  const call1 = mock.generate.mock.calls[0][0];
  const call2 = mock.generate.mock.calls[1][0];

  expect(call1.profileId).toBe('profile-1');
  expect(call2.profileId).toBe('profile-1');
  expect(call1.seed).toBeDefined();
  expect(call1.seed).toBe(call2.seed);
});


