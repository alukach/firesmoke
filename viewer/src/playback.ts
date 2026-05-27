// Playback state + reducer-style helpers used by the controls, the
// scrubber readout, the chart, and the Pm25Layer's draw() time math.
// Extracted from App.tsx so leaf components don't have to import
// their parent's file.

export const SPEEDS = [0.5, 1, 2, 4, 8, 16] as const;
export type Speed = (typeof SPEEDS)[number];

/** Snapshot used by both the layer (every draw) and the UI (10 Hz). */
export type PlaybackState = {
  playing: boolean;
  speed: Speed;
  /** performance.now() at the moment playback last started (or seeked). */
  originTime: number;
  /** Frame position [0, N) at originTime. */
  originPosition: number;
};

/** Initial playback state — paused at frame 0, default speed 4×. */
export function initialPlayback(): PlaybackState {
  return {
    playing: false,
    speed: 4,
    originTime: performance.now(),
    originPosition: 0,
  };
}

/** Continuous playhead position in [0, N), derived from time when playing. */
export function currentPosition(p: PlaybackState, N: number): number {
  if (N === 0) return 0;
  if (!p.playing) {
    let pos = p.originPosition % N;
    if (pos < 0) pos += N;
    return pos;
  }
  const dt = (performance.now() - p.originTime) / 1000;
  let pos = (p.originPosition + dt * p.speed) % N;
  if (pos < 0) pos += N;
  return pos;
}

// ---------------------------------------------------------------------------
// Reducer-style helpers — each returns a fresh PlaybackState without
// mutating the input. Use with React setPlayback(p => playOn(p)) etc.
// ---------------------------------------------------------------------------

export function playOn(p: PlaybackState): PlaybackState {
  if (p.playing) return p;
  return { ...p, playing: true, originTime: performance.now() };
}

export function pauseAt(p: PlaybackState, N: number): PlaybackState {
  if (!p.playing) return p;
  return {
    ...p,
    playing: false,
    originPosition: currentPosition(p, N),
    originTime: performance.now(),
  };
}

export function withSpeed(p: PlaybackState, speed: Speed, N: number): PlaybackState {
  if (p.speed === speed) return p;
  // Re-anchor origin so the playhead doesn't jump when speed changes.
  return {
    ...p,
    speed,
    originPosition: currentPosition(p, N),
    originTime: performance.now(),
  };
}

export function seekTo(p: PlaybackState, position: number): PlaybackState {
  return {
    ...p,
    playing: false,
    originPosition: position,
    originTime: performance.now(),
  };
}
