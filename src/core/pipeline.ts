import {
  clusterModalPeaks,
  estimateBlowsRemaining,
  estimateTemperature,
  peakCenterHz,
  resolveProfile,
} from './calibration';
import type { DetectedStrike } from './analyzer';
import type {
  AppData,
  ModalPeak,
  StrikeRecord,
  StrikeVerdict,
} from './types';

export interface PipelineOptions {
  profileKey: string;
  steels: AppData['steels'];
  sizes: AppData['sizes'];
  calibration: AppData['calibration'];
  recent?: StrikeRecord[];
  source?: StrikeRecord['source'];
  at?: string;
  audioTime?: number;
  /** Measured main-thread/worklet dispatch overhead, ms. */
  transportLatencyMs?: number;
  id?: string;
  /** Stable anvil/shop resonance frequencies that can imitate a split mode. */
  interferenceHz?: number[];
}

export function uid(prefix = 'strike'): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

export function profileCrackScore(
  modes: ModalPeak[],
  matched: Array<{ peakIndex: number; beamIndex: number }> = [],
): { score: number; detected: boolean; splitCount: number } {
  // High beam modes easily overlap the fixed anvil ring; crack decisions are
  // therefore based mainly on the fundamental and second billet mode.
  const considered = matched.length
    ? matched.filter((m) => m.beamIndex <= 1)
    : modes.map((_, peakIndex) => ({ peakIndex, beamIndex: 0 }));
  if (!considered.length) return { score: 0, detected: false, splitCount: 0 };

  let score = 0;
  let splitCount = 0;
  for (const link of considered) {
    const m = modes[link.peakIndex];
    if (!m) continue;
    const confidence = m.splitConfidence ?? (m.split ? 0.55 : 0);
    const evidence = confidence * 0.62 + m.irregularity * 0.38;
    const requiredEvidence = link.beamIndex === 0 ? 0.58 : 0.68;
    if (m.split && evidence >= requiredEvidence) {
      splitCount++;
      const modeWeight = link.beamIndex === 0 ? 1 : 0.82;
      score = Math.max(
        score,
        modeWeight *
          (0.5 +
            confidence * 0.24 +
            Math.min(0.1, (m.splitSeparationHz ?? 36) / 560) +
            m.irregularity * 0.2),
      );
    } else if (link.beamIndex === 0 && m.irregularity > 0.82) {
      score = Math.max(score, (m.irregularity - 0.38) * 0.72);
    }
  }
  if (splitCount >= 2) score = Math.min(1, score + 0.08);
  score = Math.max(0, Math.min(1, score));
  return { score, detected: score >= 0.7, splitCount };
}

export function buildRecordFromDetected(
  detected: DetectedStrike,
  opts: PipelineOptions,
): StrikeRecord {
  const profile = resolveProfile(opts.profileKey, opts.steels, opts.sizes);
  const interferenceHz = opts.interferenceHz ?? [];
  const withoutKnownResonance = detected.modes
    .filter((m) => !interferenceHz.some((a) => Math.abs(m.hz - a) < Math.max(16, a * 0.011)))
    .map((m) => {
      const touchesAnvilLine = m.splitHz?.some((f) =>
        interferenceHz.some((a) => Math.abs(f - a) < Math.max(17, a * 0.012)),
      );
      return touchesAnvilLine
        ? { ...m, split: false, splitHz: undefined, splitConfidence: 0, irregularity: Math.min(m.irregularity, 0.28) }
        : m;
    });
  const analysisModes = clusterModalPeaks(withoutKnownResonance);
  const temp = profile
    ? estimateTemperature(analysisModes, opts.calibration, profile)
    : { confidence: 0, match: null };

  const matchedLinks: Array<{ peakIndex: number; beamIndex: number }> = [];
  const matchedModeHz: number[] = [];
  const tauMs: number[] = [];
  if (temp.match) {
    for (const m of temp.match.matched) {
      if (m) {
        // Find the actual index in analysisModes by object identity.
        const idx = analysisModes.indexOf(m.observed);
        if (idx >= 0) matchedLinks.push({ peakIndex: idx, beamIndex: m.index });
        matchedModeHz.push(peakCenterHz(m.observed));
        tauMs.push(m.observed.tauMs);
      }
    }
  }

  const crack = profileCrackScore(analysisModes, matchedLinks);
  const hasAcousticBody = detected.peakLevel > 0.055 && detected.rmsLevel > 0.006;
  const profileMatchOk = !!temp.match && temp.match.matchedCount >= 2 && (temp.confidence ?? 0) > 0.48;

  let verdict: StrikeVerdict;
  if (!profile || !profileMatchOk || !hasAcousticBody) {
    verdict = 'rejected';
  } else if (crack.detected) {
    verdict = 'crack';
  } else if (temp.tempC === undefined) {
    verdict = 'rejected';
  } else if (temp.tempC < profile.steel.minForgingTempC) {
    verdict = 'cold';
  } else if (temp.tempC < profile.steel.minForgingTempC + 55) {
    verdict = 'cooling';
  } else {
    verdict = 'good';
  }

  const onsetLatencyMs =
    detected.algorithmicLatencyMs + Math.max(0, opts.transportLatencyMs ?? 0);

  const record: StrikeRecord = {
    id: opts.id ?? uid(),
    at: opts.at ?? new Date().toISOString(),
    audioTime: opts.audioTime,
    onsetLatencyMs,
    processingMs: detected.algorithmicLatencyMs,
    peakLevel: detected.peakLevel,
    rmsLevel: detected.rmsLevel,
    lowFrequencyEnergy: detected.lowFrequencyEnergy,
    modes: analysisModes,
    matchedModeHz,
    tauMs,
    frequencyScale: temp.frequencyScale,
    dampingScale: temp.dampingScale,
    tempC: temp.tempC,
    tempConfidence: temp.confidence,
    crackScore: crack.score,
    crackDetected: crack.detected,
    verdict,
    profileKey: opts.profileKey,
    source: opts.source ?? 'live',
    refined: true,
  };

  if (profile && verdict !== 'rejected') {
    record.blowsRemaining = estimateBlowsRemaining(
      record,
      opts.recent ?? [],
      profile,
      0.34,
    );
  }
  return record;
}
