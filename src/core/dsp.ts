import type { ModalPeak } from './types';

export function nextPow2(n: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(2, n)));
}

export class FFT {
  readonly size: number;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly rev: Uint16Array;

  constructor(size: number) {
    if ((size & (size - 1)) !== 0) throw new Error('FFT size must be power of two');
    this.size = size;
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    let bits = 0;
    while (1 << bits < size) bits++;
    this.rev = new Uint16Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
  }

  forward(re: Float32Array, im: Float32Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const tw = j * step;
          const wr = this.cos[tw];
          const wi = this.sin[tw];
          const a = i + j;
          const b = a + half;
          const tr = wr * re[b] - wi * im[b];
          const ti = wr * im[b] + wi * re[b];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}

export function tukeyWindow(n: number, alpha = 0.08): Float32Array {
  const w = new Float32Array(n);
  const taper = Math.floor((alpha * n) / 2);
  for (let i = 0; i < n; i++) {
    if (i < taper) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, alpha * n - 1)));
    } else if (i >= n - taper) {
      const j = n - 1 - i;
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * j) / Math.max(1, alpha * n - 1)));
    } else {
      w[i] = 1;
    }
  }
  return w;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function rms(x: Float32Array | number[], start = 0, end = x.length): number {
  let s = 0;
  for (let i = start; i < end; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, end - start));
}

/** Local windowed-DTFT peak refinement; avoids the real-signal image bias of raw phase differences. */
export function refineFrequency(
  x: Float32Array,
  sampleRate: number,
  initialHz: number,
  start = 0,
  end = x.length,
): number {
  const n = end - start;
  if (n < 32) return initialHz;
  const useN = Math.min(n, 1792);
  const begin = start + Math.floor((n - useN) * 0.08);
  const window = tukeyWindow(useN, 0.06);

  const magnitudeAt = (hz: number): number => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < useN; i++) {
      const angle = (-2 * Math.PI * hz * (begin + i)) / sampleRate;
      const v = x[begin + i] * window[i];
      re += v * Math.cos(angle);
      im += v * Math.sin(angle);
    }
    return Math.hypot(re, im);
  };

  let bestHz = initialHz;
  let bestMag = magnitudeAt(bestHz);
  const searchRound = (centerHz: number, radiusHz: number, stepHz: number): void => {
    const steps = Math.ceil(radiusHz / stepHz);
    for (let k = -steps; k <= steps; k++) {
      if (k === 0) continue;
      const hz = centerHz + k * stepHz;
      if (hz < 45 || hz > sampleRate / 2 - 100) continue;
      const mag = magnitudeAt(hz);
      if (mag > bestMag) {
        bestMag = mag;
        bestHz = hz;
      }
    }
  };

  searchRound(initialHz, 28, 4);
  searchRound(bestHz, 4, 1);
  searchRound(bestHz, 1.25, 0.25);
  return Math.max(45, bestHz);
}

interface EnvelopeFit {
  tauMs: number;
  r2: number;
  irregularity: number;
  beatHz: number;
  envelope: Array<{ t: number; amp: number; predicted: number }>;
}

export function fitDecayEnvelope(
  x: Float32Array,
  sampleRate: number,
  hz: number,
): EnvelopeFit {
  const frame = Math.floor(sampleRate * 0.0105);
  const hop = Math.floor(sampleRate * 0.0026);
  const amps: number[] = [];
  const times: number[] = [];
  const phase = (2 * Math.PI * hz) / sampleRate;

  for (let start = Math.floor(sampleRate * 0.002); start + frame <= x.length; start += hop) {
    let re = 0;
    let im = 0;
    let energy = 0;
    for (let n = 0; n < frame; n++) {
      const idx = start + n;
      const angle = phase * idx;
      const v = x[idx];
      re += v * Math.cos(angle);
      im -= v * Math.sin(angle);
      energy += v * v;
    }
    const amp = (2 * Math.hypot(re, im)) / frame;
    const broadRms = Math.sqrt(energy / frame);
    if (amp > 1e-5 && broadRms > 1e-5) {
      amps.push(amp);
      times.push((start + frame / 2) / sampleRate);
    }
  }

  if (amps.length < 4) {
    return { tauMs: 500, r2: 0, irregularity: 0.8, beatHz: 0, envelope: [] };
  }

  const maxAmp = Math.max(...amps);
  const xs: number[] = [];
  const ys: number[] = [];
  const ts: number[] = [];
  for (let i = 0; i < amps.length; i++) {
    if (amps[i] > maxAmp * 0.1) {
      xs.push(times[i]);
      ys.push(Math.log(Math.max(1e-7, amps[i])));
      ts.push(times[i]);
    }
  }
  if (xs.length < 4) {
    return { tauMs: 500, r2: 0, irregularity: 0.7, beatHz: 0, envelope: [] };
  }

  const fit = linearRegression(xs, ys);
  const slope = fit.slope;
  const tauSec = slope < -0.05 ? -1 / slope : 1.2;
  const tauMs = Math.max(24, Math.min(1200, tauSec * 1000));

  let ssRes = 0;
  let ssTot = 0;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  const envelope: EnvelopeFit['envelope'] = [];
  for (let i = 0; i < xs.length; i++) {
    const predicted = fit.intercept + slope * xs[i];
    const residual = ys[i] - predicted;
    ssRes += residual * residual;
    ssTot += (ys[i] - meanY) ** 2;
    envelope.push({ t: xs[i], amp: Math.exp(ys[i]), predicted: Math.exp(predicted) });
  }
  const r2 = ssTot > 1e-8 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  // Detrended log-envelope oscillation is the audible beat/rattle signature.
  const residualSeries = envelope.map((p) => Math.log(p.amp + 1e-7) - Math.log(p.predicted + 1e-7));
  const residualStd = Math.sqrt(
    residualSeries.reduce((a, v) => a + v * v, 0) / residualSeries.length,
  );
  let beatHz = 0;
  let beatScore = 0;
  if (residualSeries.length >= 8) {
    let bestCorr = 0;
    let bestLag = 0;
    for (let lag = 3; lag < Math.min(18, residualSeries.length - 3); lag++) {
      let c = 0;
      let n = 0;
      for (let i = 0; i + lag < residualSeries.length; i++) {
        c += residualSeries[i] * residualSeries[i + lag];
        n++;
      }
      c /= Math.max(1, n);
      if (c < -bestCorr) {
        bestCorr = -c;
        bestLag = lag;
      }
    }
    const hopSec = hop / sampleRate;
    if (bestLag > 0) {
      // Negative correlation at half a period gives an approximate beat rate.
      beatHz = 1 / (2 * bestLag * hopSec);
      beatScore = Math.min(1, bestCorr * 9);
    }
  }

  const fitIrregularity = Math.min(1, residualStd * 2.4 + (1 - r2) * 0.45);
  const irregularity = Math.max(0, Math.min(1, fitIrregularity * 0.72 + beatScore * 0.28));
  return { tauMs, r2, irregularity, beatHz, envelope };
}

export function linearRegression(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    num += dx * (ys[i] - my);
    den += dx * dx;
  }
  const slope = den > 1e-12 ? num / den : 0;
  return { slope, intercept: my - slope * mx };
}

interface LocalPeak {
  hz: number;
  magnitude: number;
  prominenceDb: number;
}

/** Dense direct-DTFT search used to resolve crack-induced doublets. */
export function detectSplitPeaks(
  x: Float32Array,
  sampleRate: number,
  centerHz: number,
): { split: boolean; peaks: [number, number] | null; separationHz: number; confidence: number } {
  const radiusHz = Math.min(115, Math.max(55, centerHz * 0.09));
  const stepHz = 2;
  const maxSamples = Math.min(x.length, Math.floor(sampleRate * 0.046));
  const start = Math.floor((x.length - maxSamples) / 2);
  const n = maxSamples;
  const window = tukeyWindow(n, 0.12);

  const freqs: number[] = [];
  const mags: number[] = [];
  const magnitudeAtHz = (f: number): number => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const angle = (-2 * Math.PI * f * (start + i)) / sampleRate;
      const v = x[start + i] * window[i];
      re += v * Math.cos(angle);
      im += v * Math.sin(angle);
    }
    return Math.hypot(re, im);
  };
  for (let f = centerHz - radiusHz; f <= centerHz + radiusHz + 0.01; f += stepHz) {
    freqs.push(f);
    mags.push(magnitudeAtHz(f));
  }

  const peaks: LocalPeak[] = [];
  for (let i = 2; i < mags.length - 2; i++) {
    if (
      mags[i] > mags[i - 1] &&
      mags[i] >= mags[i + 1] &&
      mags[i] > mags[i - 2] &&
      mags[i] >= mags[i + 2]
    ) {
      const left = Math.min(...mags.slice(Math.max(0, i - 5), i));
      const right = Math.min(...mags.slice(i + 1, Math.min(mags.length, i + 6)));
      const valley = Math.max(1e-8, Math.min(left, right));
      peaks.push({
        hz: freqs[i],
        magnitude: mags[i],
        prominenceDb: 20 * Math.log10(mags[i] / valley + 1e-9),
      });
    }
  }

  if (peaks.length < 2) return { split: false, peaks: null, separationHz: 0, confidence: 0 };
  peaks.sort((a, b) => b.magnitude - a.magnitude);
  const main = peaks[0];

  let bestPair: [LocalPeak, LocalPeak] | null = null;
  let bestScore = -Infinity;
  for (const other of peaks.slice(1, 7)) {
    const sep = Math.abs(main.hz - other.hz);
    if (sep < 19 || sep > 105) continue;
    const weaker = Math.min(main.magnitude, other.magnitude);
    const stronger = Math.max(main.magnitude, other.magnitude);
    const ratio = weaker / (stronger + 1e-9);
    if (ratio < 0.3) continue;

    const lowHz = Math.min(main.hz, other.hz);
    const highHz = Math.max(main.hz, other.hz);
    let valley = Infinity;
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] >= lowHz + 3 && freqs[i] <= highHz - 3) {
        valley = Math.min(valley, mags[i]);
      }
    }
    if (!Number.isFinite(valley)) valley = magnitudeAtHz((lowHz + highHz) / 2);
    const dipRatio = valley / weaker;
    // Reject symmetric window sidelobes around one stronger central line.
    if (dipRatio > 0.84) continue;

    const score = ratio * 8 + (0.84 - dipRatio) * 18 + Math.min(other.prominenceDb, 14) * 0.35;
    if (score > bestScore) {
      bestScore = score;
      bestPair = [main, other];
    }
  }

  if (!bestPair) return { split: false, peaks: null, separationHz: 0, confidence: 0 };
  const [a, b] = bestPair;
  const sep = Math.abs(a.hz - b.hz);
  const ratio = Math.min(a.magnitude, b.magnitude) / Math.max(a.magnitude, b.magnitude);
  let valley = Infinity;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= Math.min(a.hz, b.hz) + 3 && freqs[i] <= Math.max(a.hz, b.hz) - 3) {
      valley = Math.min(valley, mags[i]);
    }
  }
  const dipRatio = Number.isFinite(valley) ? valley / Math.min(a.magnitude, b.magnitude) : 1;
  const confidence = Math.max(
    0,
    Math.min(1, 0.25 + ratio * 0.45 + Math.max(0, 0.84 - dipRatio) * 1.4),
  );
  const split = ratio >= 0.36 && dipRatio <= 0.78 && confidence >= 0.48;
  return {
    split,
    peaks: [Math.min(a.hz, b.hz), Math.max(a.hz, b.hz)],
    separationHz: sep,
    confidence,
  };
}

export interface SpectrumPeak {
  hz: number;
  amplitude: number;
}

export function extractModalPeaks(samples: Float32Array, sampleRate: number): ModalPeak[] {
  const n = samples.length;
  const fftSize = nextPow2(Math.max(2048, n * 2));
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const w = tukeyWindow(n, 0.07);
  let windowPower = 0;
  for (let i = 0; i < n; i++) {
    re[i] = samples[i] * w[i];
    windowPower += w[i] * w[i];
  }
  const fft = new FFT(fftSize);
  fft.forward(re, im);

  const binHz = sampleRate / fftSize;
  const minBin = Math.floor(150 / binHz);
  const maxBin = Math.min(Math.ceil(6800 / binHz), fftSize / 2 - 2);
  const mag = new Float32Array(maxBin + 2);
  for (let i = minBin; i <= maxBin; i++) mag[i] = Math.hypot(re[i], im[i]) * 2 / Math.max(1, windowPower / n);

  // Local median spectral floor for prominence.
  const peaks: SpectrumPeak[] = [];
  for (let i = minBin + 3; i < maxBin - 3; i++) {
    if (mag[i] <= mag[i - 1] || mag[i] < mag[i + 1]) continue;
    if (mag[i] < mag[i - 2] || mag[i] < mag[i + 2]) continue;
    const neighborhood: number[] = [];
    for (let j = Math.max(minBin, i - 18); j <= Math.min(maxBin, i + 18); j++) {
      if (Math.abs(j - i) > 3) neighborhood.push(20 * Math.log10(mag[j] + 1e-8));
    }
    const floorDb = median(neighborhood);
    const peakDb = 20 * Math.log10(mag[i] + 1e-8);
    if (peakDb - floorDb < 7.5) continue;
    if (peakDb < -52) continue;

    // Parabolic interpolation.
    const y0 = mag[i - 1];
    const y1 = mag[i];
    const y2 = mag[i + 1];
    const denom = y0 - 2 * y1 + y2;
    const offset = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
    const hz = (i + Math.max(-1, Math.min(1, offset))) * binHz;
    peaks.push({ hz, amplitude: mag[i] });
  }

  peaks.sort((a, b) => b.amplitude - a.amplitude);
  const selected: SpectrumPeak[] = [];
  for (const p of peaks) {
    // Merge coarse peaks closer than 34 Hz; crack doublets are revisited locally.
    if (selected.every((q) => Math.abs(Math.log(q.hz / p.hz)) * p.hz > 34)) selected.push(p);
    if (selected.length >= 12) break;
  }
  selected.sort((a, b) => a.hz - b.hz);

  return selected.map((p) => {
    const hz = refineFrequency(samples, sampleRate, p.hz);
    const decay = fitDecayEnvelope(samples, sampleRate, hz);
    const splitInfo = detectSplitPeaks(samples, sampleRate, hz);
    const irregularity = Math.max(
      decay.irregularity,
      splitInfo.split ? 0.72 + splitInfo.confidence * 0.2 : decay.irregularity,
    );
    return {
      hz,
      amplitude: p.amplitude,
      tauMs: decay.tauMs,
      tauR2: decay.r2,
      split: splitInfo.split,
      splitConfidence: splitInfo.confidence,
      splitHz: splitInfo.peaks ?? undefined,
      splitSeparationHz: splitInfo.separationHz || undefined,
      irregularity: Math.max(0, Math.min(1, irregularity)),
    } satisfies ModalPeak;
  });
}
