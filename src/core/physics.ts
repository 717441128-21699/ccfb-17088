import type { BilletSize, SteelProfile } from './types';

export const REFERENCE_TEMP_C = 20;

/** Free-free rectangular beam modal constants, first four modes. */
const BEAM_K = [4.73004074, 7.85320462, 10.9956078, 14.1371655];

export function thermalFrequencyScale(steel: SteelProfile, tempC: number): number {
  const d = Math.max(0, tempC - REFERENCE_TEMP_C);
  const modulusRatio = Math.max(0.22, 1 - steel.softeningA * d - steel.softeningB * d * d);
  return Math.sqrt(modulusRatio);
}

export function dampingScale(steel: SteelProfile, tempC: number): number {
  // Hot steel has much higher internal damping.
  return Math.exp(-steel.dampingCoefficient * Math.max(0, tempC - REFERENCE_TEMP_C));
}

/** Ideal free-free bar frequencies in Hz for the first four bending modes. */
export function billetModes(
  size: BilletSize,
  steel: SteelProfile,
  tempC = REFERENCE_TEMP_C,
): number[] {
  const L = size.lengthMm / 1000;
  const h = size.thicknessMm / 1000;
  const c = h * Math.sqrt(steel.elasticModulusGpa * 1e9 / (12 * steel.densityKgM3));
  const thermal = thermalFrequencyScale(steel, tempC);
  return BEAM_K.map((k) => ((k * k) / (2 * Math.PI * L * L)) * c * thermal);
}

export function nominalTauMs(
  size: BilletSize,
  steel: SteelProfile,
  tempC: number,
  modeIndex = 0,
): number {
  // Large/thick blanks ring longer. Mode order also decays faster.
  const geometry = 0.45 + size.lengthMm / 650 + size.thicknessMm / 45;
  const coldTauMs = 620 * geometry;
  const hot = coldTauMs * dampingScale(steel, tempC);
  const modeFactor = 1 / (1 + modeIndex * 0.58);
  return Math.max(34, hot * modeFactor);
}

export const ANVIL_MODES_HZ = [1765, 2648, 3972, 5280];
export const ANVIL_TAU_MS = [210, 145, 92, 58];
export const HAMMER_CLICK_HZ = [2350, 3420, 4860, 6320];

export function profileKey(steelId: string, sizeId: string): string {
  return `${steelId}::${sizeId}`;
}

export function parseProfileKey(key: string): { steelId: string; sizeId: string } {
  const [steelId, sizeId] = key.split('::');
  return { steelId, sizeId };
}
