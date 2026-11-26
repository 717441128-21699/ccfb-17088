import type { AudioEngine } from '../../audio/AudioEngine';

export interface PageContext {
  engine: AudioEngine;
  refresh: () => void;
}

export interface PageHandle {
  root: HTMLElement;
  cleanup?: () => void;
}
