import { median } from './dsp';
import { billetModes, nominalTauMs } from './physics';
import type {
  BilletSize,
  CalibrationPoint,
  ModalPeak,
  SteelProfile,
  StrikeRecord,
} from './types';

export interface ResolvedProfile {
  steel: SteelProfile;
  size: BilletSize;
  key: string;
  refModesHz: number[];
  refTauMs: number[];
}

export function resolveProfile(
  key: string,
  steels: SteelProfile[],
  sizes: BilletSize[],
): ResolvedProfile | undefined {
  const [steelId, sizeId] = key.split('::');
  const steel = steels.find((s) => s.id === steelId);
  const size = sizes.find((s) => s.id === sizeId);
  if (!steel || !size) return undefined;
  // Calibration uses the first three reliable beam modes.
  const refModesHz = billetModes(size, steel, 20).slice(0, 3);
  const refTauMs = refModesHz.map((_, i) => nominalTauMs(size, steel, 20, i));
  return { steel, size, key, refModesHz, refTauMs };
}

export interface ModeMatch {
  scale: number;
  matched: Array<{ refHz: number; observed: ModalPeak; index: number; residual: number } | null>;
  matchedCount: number;
  score: number;
  meanResidual: number;
}

export function peakCenterHz(peak: ModalPeak): number {
  // A low-confidence local doublet label is usually window/anvil leakage; the
  // refined main peak or amplitude-weighted cluster center is safer.
  if (peak.split && (peak.splitConfidence ?? 0) >= 0.7 && peak.splitHz?.length === 2) {
    return (peak.splitHz[0] + peak.splitHz[1]) / 2;
  }
  return peak.hz;
}

/**
 * Merge the two lines of a crack doublet (and repeated local-DTFT labels)
 * into one modal observation. Normal beam modes are much farther apart.
 */
export function clusterModalPeaks(peaks: ModalPeak[]): ModalPeak[] {
  const sorted = [...peaks].sort((a, b) => a.hz - b.hz);
  const groups: ModalPeak[][] = [];
  for (const peak of sorted) {
    const last = groups[groups.length - 1];
    if (last) {
      const lastHz = last[last.length - 1].hz;
      const gap = peak.hz - lastHz;
      if (gap <= 112 && gap / lastHz <= 0.45) {
        last.push(peak);
        continue;
      }
    }
    groups.push([peak]);
  }

  return groups.map((group) => {
    if (group.length === 1) return group[0];
    const totalAmp = group.reduce((a, p) => a + p.amplitude, 0);
    const hz = group.reduce((a, p) => a + p.hz * p.amplitude, 0) / totalAmp;
    const strongest = [...group].sort((a, b) => b.amplitude - a.amplitude)[0];
    const twoStrongest = [...group].sort((a, b) => b.amplitude - a.amplitude).slice(0, 2);
    const hzPair: [number, number] = [
      Math.min(twoStrongest[0].hz, twoStrongest[1]?.hz ?? hz),
      Math.max(twoStrongest[0].hz, twoStrongest[1]?.hz ?? hz),
    ];
    const separation = Math.abs(hzPair[1] - hzPair[0]);
    const alreadySplit = group.some((p) => p.split);
    return {
      ...strongest,
      hz,
      split: alreadySplit || separation >= 22,
      splitConfidence: Math.max(
        ...group.map((p) => p.splitConfidence ?? 0),
        group.length > 1 ? 0.55 : 0,
      ),
      splitHz: separation >= 14 ? hzPair : strongest.splitHz,
      splitSeparationHz: separation || strongest.splitSeparationHz,
      irregularity: Math.max(...group.map((p) => p.irregularity)),
      tauR2: Math.max(...group.map((p) => p.tauR2)),
    } satisfies ModalPeak;
  });
}

export function matchModesToProfile(peaks: ModalPeak[], refModesHz: number[]): ModeMatch | null {
  if (peaks.length === 0 || refModesHz.length === 0) return null;
  let best: ModeMatch | null = null;

  // Forging temperatures normally move modes to 58–94% of room-temperature frequency.
  for (let scale = 0.56; scale <= 0.9601; scale += 0.004) {
    const matched: ModeMatch['matched'] = refModesHz.map((refHz, index) => {
      const expected = refHz * scale;
      let bestPeak: ModalPeak | undefined;
      let bestResidual = Infinity;
      for (const p of peaks) {
        const observedHz = peakCenterHz(p);
        const residual = Math.abs(Math.log(observedHz / expected));
        // 5.5% gate; higher modes are allowed a little more inharmonicity.
        const gate = 0.055 + index * 0.012;
        if (residual < gate && residual < bestResidual) {
          bestResidual = residual;
          bestPeak = p;
        }
      }
      return bestPeak
        ? { refHz, observed: bestPeak, index, residual: bestResidual }
        : null;
    });

    const count = matched.filter(Boolean).length;
    if (count < 2) continue;
    const weights = [1.35, 1.0, 0.72, 0.5];
    let score = count * 10;
    let residualSum = 0;
    let weightSum = 0;
    matched.forEach((m, modeIndex) => {
      if (m) {
        const w = weights[m.index] ?? 0.5;
        score += w * (1 - Math.min(1, m.residual / 0.09));
        residualSum += m.residual * w;
        weightSum += w;
      } else {
        score -= 1.8 * (weights[modeIndex] ?? 1);
      }
    });
    const meanResidual = weightSum ? residualSum / weightSum : 1;
    score -= meanResidual * 8;
    if (!best || score > best.score) {
      best = { scale, matched, matchedCount: count, score, meanResidual };
    }
  }

  // Robust continuous scale: reject one mode pulled by overlap/anvil residue.
  if (best) {
    const weights = [1.45, 1.05, 0.72, 0.5];
    const observations = best.matched
      .map((m) =>
        m
          ? {
              logRatio: Math.log(peakCenterHz(m.observed) / m.refHz),
              weight: weights[m.index] ?? 0.5,
            }
          : null,
      )
      .filter((x): x is { logRatio: number; weight: number } => !!x);

    if (observations.length) {
      const medianLog = median(observations.map((o) => o.logRatio));
      const inliers = observations.filter((o) => Math.abs(o.logRatio - medianLog) < 0.052);
      const used = inliers.length >= 2 ? inliers : observations;
      if (used.length >= 3) {
        // Modal doublets can bias the fundamental; the median ratio is robust.
        const sortedLogs = used.map((o) => o.logRatio).sort((a, b) => a - b);
        const mid = sortedLogs.length >> 1;
        best.scale = Math.exp(
          sortedLogs.length % 2 ? sortedLogs[mid] : (sortedLogs[mid - 1] + sortedLogs[mid]) / 2,
        );
      } else {
        let wSum = 0;
        let vSum = 0;
        for (const o of used) {
          vSum += o.logRatio * o.weight;
          wSum += o.weight;
        }
        best.scale = Math.exp(vSum / Math.max(1e-6, wSum));
      }
    }
  }
  return best;
}

interface ScalePoint {
  tempC: number;
  frequencyScale: number;
  tauScale: number;
}

export function calibrationScalePoints(
  calibration: CalibrationPoint[],
  key: string,
  profile: ResolvedProfile,
): ScalePoint[] {
  const points = calibration
    .filter((p) => p.profileKey === key)
    .map((p) => {
      const modeCount = Math.min(p.modesHz.length, profile.refModesHz.length);
      const freqScales: number[] = [];
      const tauScales: number[] = [];
      for (let i = 0; i < modeCount; i++) {
        if (p.modesHz[i] > 0) freqScales.push(p.modesHz[i] / profile.refModesHz[i]);
        if (p.tauMs[i] > 0) tauScales.push(p.tauMs[i] / profile.refTauMs[i]);
      }
      return {
        tempC: p.tempC,
        frequencyScale: geometricMean(freqScales),
        tauScale: geometricMean(tauScales),
      };
    })
    .filter((p) => Number.isFinite(p.frequencyScale))
    .sort((a, b) => a.tempC - b.tempC);

  // IR-gun and peak-picking noise make adjacent raw points jagged. A small
  // centered smoother preserves monotonic thermal softening while avoiding
  // one noisy calibration segment biasing the temperature by tens of degrees.
  if (points.length >= 5) {
    const originalFreq = points.map((p) => p.frequencyScale);
    const originalTau = points.map((p) => p.tauScale);
    for (let i = 0; i < points.length; i++) {
      if (i > 0 && i < points.length - 1) {
        points[i].frequencyScale =
          (originalFreq[i - 1] + 2 * originalFreq[i] + originalFreq[i + 1]) / 4;
        points[i].tauScale =
          (originalTau[i - 1] + 2 * originalTau[i] + originalTau[i + 1]) / 4;
      }
    }
  }
  return points;
}

function geometricMean(values: number[]): number {
  if (!values.length) return Number.NaN;
  return Math.exp(values.reduce((a, v) => a + Math.log(Math.max(1e-6, v)), 0) / values.length);
}

export function tempFromMonotonicScale(
  points: ScalePoint[],
  observed: number,
  kind: 'frequencyScale' | 'tauScale',
): number | undefined {
  const usable = points
    .filter((p) => Number.isFinite(p[kind]) && p[kind] > 0)
    .sort((a, b) => b[kind] - a[kind]); // scale descending, temperature ascending

  if (usable.length < 2 || !Number.isFinite(observed) || observed <= 0) return undefined;

  if (observed >= usable[0][kind]) return usable[0].tempC;
  if (observed <= usable[usable.length - 1][kind]) return usable[usable.length - 1].tempC;

  for (let i = 0; i < usable.length - 1; i++) {
    const hi = usable[i];
    const lo = usable[i + 1];
    const a = hi[kind];
    const b = lo[kind];
    if (observed <= a && observed >= b && Math.abs(a - b) > 1e-6) {
      const t = (observed - b) / (a - b);
      return lo.tempC + (hi.tempC - lo.tempC) * t;
    }
  }
  return undefined;
}

export interface TempEstimate {
  tempC?: number;
  confidence: number;
  frequencyTempC?: number;
  dampingTempC?: number;
  frequencyScale?: number;
  dampingScale?: number;
  match?: ModeMatch | null;
}

export function estimateTemperature(
  peaks: ModalPeak[],
  calibration: CalibrationPoint[],
  profile: ResolvedProfile,
): TempEstimate {
  const match = matchModesToProfile(peaks, profile.refModesHz);
  if (!match || match.matchedCount < 2) {
    return { confidence: 0, match };
  }

  const points = calibrationScalePoints(calibration, profile.key, profile);
  const frequencyScale = match.scale;

  const tauObservations: Array<{ ratio: number; r2: number }> = [];
  for (const m of match.matched) {
    if (m && Number.isFinite(m.observed.tauMs) && m.observed.tauMs > 0) {
      tauObservations.push({
        ratio: m.observed.tauMs / profile.refTauMs[m.index],
        r2: Number.isFinite(m.observed.tauR2) ? m.observed.tauR2 : 0,
      });
    }
  }
  const dampingScale = tauObservations.length
    ? geometricMean(tauObservations.map((t) => t.ratio))
    : undefined;

  const frequencyTempC = tempFromMonotonicScale(points, frequencyScale, 'frequencyScale');
  const dampingTempC =
    dampingScale === undefined
      ? undefined
      : tempFromMonotonicScale(points, dampingScale, 'tauScale');

  const residualConfidence = Math.max(0, 1 - match.meanResidual * 12);
  const countConfidence = Math.min(1, match.matchedCount / 3);
  let confidence = 0.42 + 0.38 * residualConfidence + 0.2 * countConfidence;

  let tempC = frequencyTempC;
  if (frequencyTempC !== undefined && dampingTempC !== undefined) {
    const meanTauR2 =
      tauObservations.reduce((a, t) => a + Math.max(0, t.r2), 0) /
      Math.max(1, tauObservations.length);
    const reliability = Math.max(0, Math.min(1, (meanTauR2 - 0.58) / 0.32));
    // Damping is displayed and cross-checked; modal frequency carries the estimate.
    const dampingWeight = 0.07 * Math.min(1, tauObservations.length / 3) * reliability;
    tempC = frequencyTempC * (1 - dampingWeight) + dampingTempC * dampingWeight;
    confidence *= 0.96 + 0.03 * reliability;
  } else {
    confidence *= 0.82;
  }

  if (tempC === undefined) confidence = 0;
  return {
    tempC,
    confidence: Math.max(0, Math.min(0.98, confidence)),
    frequencyTempC,
    dampingTempC,
    frequencyScale,
    dampingScale,
    match,
  };
}

export function estimateBlowsRemaining(
  current: StrikeRecord,
  recent: StrikeRecord[],
  profile: ResolvedProfile,
  intervalSec = 0.34,
): number | undefined {
  if (current.tempC === undefined) return undefined;
  const threshold = profile.steel.minForgingTempC;
  let lossPerBlow = profile.size.tempLossPerBlowC + profile.size.coolingCPerSec * intervalSec;

  const sameProfile = recent
    .filter((s) => s.profileKey === profile.key && typeof s.tempC === 'number' && s.audioTime !== undefined)
    .slice(-9);
  if (sameProfile.length >= 4) {
    const first = sameProfile[0];
    const last = sameProfile[sameProfile.length - 1];
    const dt = (last.audioTime ?? 0) - (first.audioTime ?? 0);
    const dT = (last.tempC ?? 0) - (first.tempC ?? 0);
    if (dt > 0.5 && dT < 0) {
      const blows = sameProfile.length - 1;
      const observedLoss = (-dT / dt) * intervalSec + (-dT / blows) * 0.35;
      if (Number.isFinite(observedLoss) && observedLoss > 1 && observedLoss < 60) {
        lossPerBlow = lossPerBlow * 0.45 + observedLoss * 0.55;
      }
    }
  }

  return Math.max(0, Math.floor((current.tempC - threshold) / lossPerBlow + 0.35));
}
