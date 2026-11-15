import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { SubtitlesPage } from './srt-voice-page';

const mock = vi.hoisted(() => ({
  generate: vi.fn(),
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
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

it('adjusts cue duration and shifts subsequent cues ripple-wise', async () => {
  mock.apiJson.mockResolvedValueOnce({
    filename: 'test.srt',
    total_cues: 2,
    total_duration: 6.0,
    cues: [
      { id: 1, start: 0.0, end: 2.0, duration: 2.0, text: 'First line' },
      { id: 2, start: 3.0, end: 5.0, duration: 2.0, text: 'Second line' },
    ],
  });

  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <SubtitlesPage />
    </QueryClientProvider>,
  );

  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [new File(['srt'], 'test.srt')] } });

  await waitFor(() => {
    expect(screen.getByDisplayValue('First line')).toBeInTheDocument();
  });

  const plusButtons = screen.getAllByRole('button', { name: 'Increase duration 0.5s' });
  fireEvent.click(plusButtons[0]);

  // Cue 1 duration becomes 2.5s -> end becomes 2.5s (delta = +0.5s)
  // Cue 2 start should become 3.5s and end should become 5.5s
  await waitFor(() => {
    expect(screen.getByText('0:03.50 → 0:05.50')).toBeInTheDocument();
  });
});

it('generates only missing cues when selecting generate_missing option', async () => {
  mock.apiJson.mockResolvedValueOnce({
    filename: 'test.srt',
    total_cues: 2,
    total_duration: 6.0,
    cues: [
      { id: 1, start: 0.0, end: 2.0, duration: 2.0, text: 'First line' },
      { id: 2, start: 3.0, end: 5.0, duration: 2.0, text: 'Second line' },
    ],
  });

  mock.generate.mockResolvedValueOnce({ audioPath: 'c1.wav', blob: new Blob(['a']) });

  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <SubtitlesPage />
    </QueryClientProvider>,
  );

  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [new File(['srt'], 'test.srt')] } });

  await waitFor(() => {
    expect(screen.getByDisplayValue('First line')).toBeInTheDocument();
  });

  // Generate only first cue individually using single cue generate button
  const generateButtons = screen.getAllByRole('button', { name: 'srtVoice.generate_cue' });
  fireEvent.click(generateButtons[0]);

  await waitFor(() => {
    expect(mock.generate).toHaveBeenCalledTimes(1);
  });

  // Open dropdown and click "Chỉ tạo câu chưa có"
  const dropdownTrigger = screen.getByRole('button', { name: 'Generate options' });
  fireEvent.click(dropdownTrigger);

  const missingBtn = await screen.findByRole('button', { name: 'srtVoice.generate_missing' });
  fireEvent.click(missingBtn);

  await waitFor(() => {
    // Only the second cue should be generated, total generate calls = 2
    expect(mock.generate).toHaveBeenCalledTimes(2);
    expect(mock.generate.mock.calls[1][0].text).toBe('Second line');
  });
});

it('generates voice for selected cues only when selecting generate_selected option', async () => {
  mock.apiJson.mockResolvedValueOnce({
    filename: 'test.srt',
    total_cues: 3,
    total_duration: 6.0,
    cues: [
      { id: 1, start: 0.0, end: 2.0, duration: 2.0, text: 'First line' },
      { id: 2, start: 2.0, end: 4.0, duration: 2.0, text: 'Second line' },
      { id: 3, start: 4.0, end: 6.0, duration: 2.0, text: 'Third line' },
    ],
  });

  mock.generate.mockResolvedValueOnce({ audioPath: 'c2.wav', blob: new Blob(['a']) });

  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <SubtitlesPage />
    </QueryClientProvider>,
  );

  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [new File(['srt'], 'test.srt')] } });

  await waitFor(() => {
    expect(screen.getByDisplayValue('First line')).toBeInTheDocument();
  });

  // Check cue 2 only
  const checkboxes = screen.getAllByRole('checkbox');
  fireEvent.click(checkboxes[1]);

  // Open dropdown and click "Chỉ tạo voice cho câu đã chọn"
  const dropdownTrigger = screen.getByRole('button', { name: 'Generate options' });
  fireEvent.click(dropdownTrigger);

  const selectedBtn = await screen.findByRole('button', { name: /srtVoice\.generate_selected/ });
  fireEvent.click(selectedBtn);

  await waitFor(() => {
    expect(mock.generate).toHaveBeenCalledTimes(1);
    expect(mock.generate.mock.calls[0][0].text).toBe('Second line');
  });
});


it('supports cue selection mode and assembling only selected cues', async () => {
  mock.apiJson
    .mockResolvedValueOnce({
      filename: 'multi.srt',
      total_cues: 3,
      total_duration: 10.0,
      cues: [
        { id: 1, start: 0.0, end: 2.0, duration: 2.0, text: 'Cue 1' },
        { id: 2, start: 3.0, end: 5.0, duration: 2.0, text: 'Cue 2' },
        { id: 3, start: 6.0, end: 8.0, duration: 2.0, text: 'Cue 3' },
      ],
    })
    .mockResolvedValueOnce({
      audio_url: '/audio/partial.wav',
      duration: 5.0,
      filename: 'partial.wav',
    });

  mock.generate
    .mockResolvedValueOnce({ audioPath: 'c1.wav', blob: new Blob(['a']) })
    .mockResolvedValueOnce({ audioPath: 'c2.wav', blob: new Blob(['b']) })
    .mockResolvedValueOnce({ audioPath: 'c3.wav', blob: new Blob(['c']) });

  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <SubtitlesPage />
    </QueryClientProvider>,
  );

  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [new File(['srt'], 'multi.srt')] } });

  await waitFor(() => {
    expect(screen.getByDisplayValue('Cue 1')).toBeInTheDocument();
  });

  // Generate all cues
  fireEvent.click(screen.getByRole('button', { name: 'srtVoice.generate_all' }));
  await waitFor(() => {
    expect(mock.generate).toHaveBeenCalledTimes(3);
  });

  // Checkboxes are always visible
  const checkboxes = screen.getAllByRole('checkbox');
  expect(checkboxes.length).toBe(3);

  // Select cue 2 and cue 3
  fireEvent.click(checkboxes[1]);
  fireEvent.click(checkboxes[2]);

  // Open Assemble options dropdown and click "Ghép câu đã chọn"
  const assembleDropdownTrigger = screen.getByRole('button', { name: 'Assemble options' });
  fireEvent.click(assembleDropdownTrigger);

  const assembleSelectedBtn = await screen.findByRole('button', {
    name: /srtVoice\.assemble_selected/,
  });
  fireEvent.click(assembleSelectedBtn);

  await waitFor(() => {
    expect(mock.apiJson).toHaveBeenCalledWith(
      '/srt/assemble',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"id":2'),
      }),
    );
  });

  // Verify only cues 2 and 3 were sent to assemble
  const assembleCall = mock.apiJson.mock.calls.find((call) => call[0] === '/srt/assemble');
  expect(assembleCall).toBeDefined();
  const payload = JSON.parse(assembleCall![1].body);
  expect(payload.cues).toHaveLength(2);
  expect(payload.cues[0].id).toBe(2);
  expect(payload.cues[1].id).toBe(3);
  // And start should be normalized relative to minStart (cue 2 start=3.0 -> 0.0)
  expect(payload.cues[0].start).toBe(0);
});

it('disables assemble_selected button when no selected cues have audio', async () => {
  mock.apiJson.mockResolvedValueOnce({
    filename: 'test.srt',
    total_cues: 2,
    total_duration: 5.0,
    cues: [
      { id: 1, start: 0.0, end: 2.0, duration: 2.0, text: 'Line 1' },
      { id: 2, start: 2.5, end: 5.0, duration: 2.5, text: 'Line 2' },
    ],
  });

  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <SubtitlesPage />
    </QueryClientProvider>,
  );

  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [new File(['srt'], 'test.srt')] } });

  await waitFor(() => {
    expect(screen.getByDisplayValue('Line 1')).toBeInTheDocument();
  });

  const checkboxes = screen.getAllByRole('checkbox');
  // Check cue 1
  fireEvent.click(checkboxes[0]);

  // Open Assemble options dropdown
  const assembleDropdownTrigger = screen.getByRole('button', { name: 'Assemble options' });
  fireEvent.click(assembleDropdownTrigger);

  const assembleSelectedBtn = await screen.findByRole('button', {
    name: /srtVoice\.assemble_selected/,
  });
  expect(assembleSelectedBtn).toBeDisabled();
});

it('adjusts duration for all selected cues and updates both timeStart and timeFinish for subsequent cues', async () => {
  mock.apiJson.mockResolvedValueOnce({
    filename: 'test.srt',
    total_cues: 3,
    total_duration: 6.0,
    cues: [
      { id: 1, start: 0.0, end: 2.0, duration: 2.0, text: 'Line 1' },
      { id: 2, start: 2.0, end: 4.0, duration: 2.0, text: 'Line 2' },
      { id: 3, start: 4.0, end: 6.0, duration: 2.0, text: 'Line 3' },
    ],
  });

  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <SubtitlesPage />
    </QueryClientProvider>,
  );

  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [new File(['srt'], 'test.srt')] } });

  await waitFor(() => {
    expect(screen.getByDisplayValue('Line 1')).toBeInTheDocument();
  });

  const checkboxes = screen.getAllByRole('checkbox');
  // Select cue 2 and cue 3
  fireEvent.click(checkboxes[1]);
  fireEvent.click(checkboxes[2]);

  // Click batch increase +0.5s
  const batchPlusBtn = screen.getByRole('button', {
    name: 'Increase selected duration 0.5s',
  });
  fireEvent.click(batchPlusBtn);

  // Cue 1: remains 0:00.00 → 0:02.00
  // Cue 2: start 2.00, duration 2.5s -> end becomes 4.50 (timeFinish changed)
  // Cue 3: start shifts to 4.50 (timeStart changed!), duration 2.5s -> end becomes 7.00 (timeFinish changed!)
  await waitFor(() => {
    expect(screen.getByText('0:02.00 → 0:04.50')).toBeInTheDocument();
    expect(screen.getByText('0:04.50 → 0:07.00')).toBeInTheDocument();
  });
});







