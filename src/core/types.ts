export type PageId = 'monitor' | 'strikes' | 'temperature' | 'calibration';

export interface SteelProfile {
  id: string;
  name: string;
  /** Young's modulus at 20 °C, GPa */
  elasticModulusGpa: number;
  densityKgM3: number;
  /** Linear thermal softening coefficient for E/E0 = 1 - aΔT - bΔT² */
  softeningA: number;
  softeningB: number;
  /** Damping coefficient; larger means hot steel dies away faster */
  dampingCoefficient: number;
  minForgingTempC: number;
  notes?: string;
}

export interface BilletSize {
  id: string;
  steelId: string;
  label: string;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  /** User-estimated heat lost per ordinary blow, °C */
  tempLossPerBlowC: number;
  /** Radiative/conductive cooling while waiting between blows, °C/s */
  coolingCPerSec: number;
}

export interface CalibrationPoint {
  id: string;
  profileKey: string;
  tempC: number;
  measuredAt: string;
  modesHz: number[];
  tauMs: number[];
  /** Optional IR-gun distance/emissivity note */
  note?: string;
  synthetic?: boolean;
}

export interface ModalPeak {
  hz: number;
  amplitude: number;
  tauMs: number;
  tauR2: number;
  /** True when a close doublet / beating is visible around this mode */
  split: boolean;
  splitConfidence?: number;
  splitHz?: [number, number];
  splitSeparationHz?: number;
  irregularity: number;
}

export type StrikeVerdict = 'good' | 'cooling' | 'cold' | 'crack' | 'rejected';

export interface StrikeRecord {
  id: string;
  at: string;
  /** AudioContext time of the onset, seconds */
  audioTime?: number;
  onsetLatencyMs: number;
  processingMs?: number;
  peakLevel: number;
  rmsLevel: number;
  lowFrequencyEnergy: number;
  modes: ModalPeak[];
  matchedModeHz: number[];
  tauMs: number[];
  frequencyScale?: number;
  dampingScale?: number;
  tempC?: number;
  tempConfidence?: number;
  blowsRemaining?: number;
  crackScore: number;
  crackDetected: boolean;
  verdict: StrikeVerdict;
  profileKey?: string;
  source: 'live' | 'synthetic';
  /** Final Worklet message can refine decay after the prompt has appeared */
  refined?: boolean;
  error?: string;
}

export interface MonitorSettings {
  selectedMicId?: string;
  profileKey: string;
  inputGain: number;
  thresholdDb: number;
  rejectOtherHammers: boolean;
  blowerSuppression: boolean;
  showSpectrum: boolean;
}

export interface AppData {
  version: 1;
  settings: MonitorSettings;
  steels: SteelProfile[];
  sizes: BilletSize[];
  calibration: CalibrationPoint[];
  strikes: StrikeRecord[];
}

export interface DetectorOptions {
  sampleRate: number;
  profileKey?: string;
  threshold?: number;
  rejectOtherHammers?: boolean;
  now?: () => number;
}

export interface GroundTruthStrike {
  onsetSample: number;
  tempC: number;
  crack: boolean;
  steelId: string;
  sizeId: string;
  strength: number;
}
