import { extractModalPeaks, rms } from './dsp';
import type { ModalPeak } from './types';

export interface DetectedStrike {
  onsetSample: number;
  readySample: number;
  algorithmicLatencyMs: number;
  sampleRate: number;
  peakLevel: number;
  rmsLevel: number;
  lowFrequencyEnergy: number;
  highFrequencyEnergy: number;
  modes: ModalPeak[];
  crackScore: number;
  crackDetected: boolean;
  windowSamples: number;
}

interface PendingWindow {
  buffer: Float32Array;
  writeOffset: number;
  onsetSample: number;
  peak: number;
  allSq: number;
  lowSq: number;
  highSq: number;
  count: number;
}

export interface AnalyzerOptions {
  sampleRate: number;
  thresholdDb?: number;
  /** Minimum separation between accepted onsets, ms. Three strikes/s is 333 ms. */
  refractoryMs?: number;
  windowSamples?: number;
  preSamples?: number;
}

/**
 * Streaming hammer onset and modal extractor.
 * The same class runs inside AudioWorklet and in Node synthetic validation.
 */
export class HammerAnalyzer {
  readonly sampleRate: number;
  thresholdDb: number;
  readonly windowSamples: number;
  readonly preSamples: number;

  private frame = 0;
  private lastCandidateFrame = -10_000_000;
  private lastStrongOnsetFrame = -10_000_000;
  private candidateRefractorySamples: number;
  private ringGuardSamples: number;
  private hpPrevInput = 0;
  private hpPrevOutput = 0;
  private lp = 0;
  private lastHpRms = 0.002;
  private hpHistory: number[] = [];
  private noiseHpRms = 0.004;
  private noiseRms = 0.008;
  private adaptationBlocks = 0;

  private preRing: Float32Array;
  private preWrite = 0;
  private preCount = 0;
  private pending: PendingWindow | null = null;

  constructor(options: AnalyzerOptions) {
    this.sampleRate = options.sampleRate;
    this.thresholdDb = options.thresholdDb ?? -36;
    this.windowSamples = options.windowSamples ?? 2048;
    this.preSamples = options.preSamples ?? 256;
    this.candidateRefractorySamples = Math.floor(0.024 * this.sampleRate);
    this.ringGuardSamples = Math.floor((options.refractoryMs ?? 245) * this.sampleRate / 1000);
    this.preRing = new Float32Array(this.preSamples);
  }

  reset(): void {
    this.frame = 0;
    this.lastCandidateFrame = -10_000_000;
    this.lastStrongOnsetFrame = -10_000_000;
    this.hpPrevInput = 0;
    this.hpPrevOutput = 0;
    this.lp = 0;
    this.lastHpRms = 0.002;
    this.hpHistory = [];
    this.noiseHpRms = 0.004;
    this.noiseRms = 0.008;
    this.adaptationBlocks = 0;
    this.preRing.fill(0);
    this.preWrite = 0;
    this.preCount = 0;
    this.pending = null;
  }

  process(input: Float32Array): DetectedStrike[] {
    const strikes: DetectedStrike[] = [];
    const blockStartFrame = this.frame;
    const n = input.length;
    if (!n) return strikes;

    const hp = new Float32Array(n);
    let hpSq = 0;
    let allSq = 0;
    let lowSq = 0;
    let peak = 0;
    const hpAlpha = Math.exp((-2 * Math.PI * 620) / this.sampleRate);
    const lpAlpha = 1 - Math.exp((-2 * Math.PI * 190) / this.sampleRate);

    for (let i = 0; i < n; i++) {
      const x = input[i] || 0;
      allSq += x * x;
      peak = Math.max(peak, Math.abs(x));
      const yHp = hpAlpha * (this.hpPrevOutput + x - this.hpPrevInput);
      this.hpPrevInput = x;
      this.hpPrevOutput = yHp;
      hp[i] = yHp;
      hpSq += yHp * yHp;

      this.lp += lpAlpha * (x - this.lp);
      lowSq += this.lp * this.lp;
    }

    const hpRms = Math.sqrt(hpSq / n);
    const blockRms = Math.sqrt(allSq / n);

    let onsetNow = false;
    if (!this.pending) {
      onsetNow = this.detectOnset(hpRms, blockRms, peak, blockStartFrame);
    }

    if (onsetNow) {
      this.lastCandidateFrame = blockStartFrame;
      if (peak > 0.43 || hpRms > 0.19) this.lastStrongOnsetFrame = blockStartFrame;
      const pre = this.snapshotPreRing();
      const buffer = new Float32Array(this.windowSamples);
      buffer.set(pre, 0);
      this.pending = {
        buffer,
        writeOffset: pre.length,
        onsetSample: blockStartFrame,
        peak,
        allSq,
        lowSq,
        highSq: hpSq,
        count: n,
      };
      this.appendPending(input, hpSq, allSq, lowSq, peak);
    } else if (this.pending) {
      this.appendPending(input, hpSq, allSq, lowSq, peak);
    } else {
      this.adaptNoiseFloor(hpRms, blockRms, false);
    }

    this.writePreRing(input);
    this.lastHpRms = hpRms;
    this.hpHistory.push(hpRms);
    if (this.hpHistory.length > 6) this.hpHistory.shift();
    this.frame += n;

    if (this.pending && this.pending.writeOffset >= this.windowSamples) {
      const p = this.pending;
      this.pending = null;
      const result = this.finalize(p);
      if (result) strikes.push(result);
    }

    return strikes;
  }

  private detectOnset(hpRms: number, blockRms: number, peak: number, frame: number): boolean {
    this.adaptationBlocks++;
    if (this.adaptationBlocks < 8) {
      this.adaptNoiseFloor(hpRms, blockRms, true);
    }

    const sinceCandidate = frame - this.lastCandidateFrame;
    const sinceStrong = frame - this.lastStrongOnsetFrame;
    if (sinceCandidate < this.candidateRefractorySamples) {
      this.adaptNoiseFloor(hpRms, blockRms, false);
      return false;
    }
    if (sinceStrong < this.ringGuardSamples && peak < 0.58 && hpRms < 0.25) {
      this.adaptNoiseFloor(hpRms, blockRms, false);
      return false;
    }

    const absoluteGate = Math.pow(10, this.thresholdDb / 20) * 0.46;
    const ratio = hpRms / Math.max(0.00008, this.noiseHpRms);
    const rmsRatio = blockRms / Math.max(0.0002, this.noiseRms);
    const historyFloor = this.hpHistory.length ? Math.min(...this.hpHistory) : this.lastHpRms;
    const sharpRise =
      hpRms > this.lastHpRms * 1.32 &&
      hpRms > historyFloor * 1.55 &&
      (this.lastHpRms < absoluteGate * 1.7 || ratio > 3.2);
    const isOnset =
      hpRms > absoluteGate &&
      ratio > 2.1 &&
      rmsRatio > 1.35 &&
      sharpRise;

    if (!isOnset) this.adaptNoiseFloor(hpRms, blockRms, false);
    return isOnset;
  }

  private adaptNoiseFloor(hpRms: number, rms: number, initial: boolean): void {
    if (initial) {
      const a = this.adaptationBlocks < 20 ? 0.22 : 0.06;
      this.noiseHpRms += (Math.max(hpRms, 0.00012) - this.noiseHpRms) * a;
      this.noiseRms += (Math.max(rms, 0.0004) - this.noiseRms) * a;
      return;
    }
    // Do not let a long ringing anvil pull the ambient floor upward quickly.
    if (hpRms < this.noiseHpRms * 2.1) {
      this.noiseHpRms = this.noiseHpRms * 0.965 + hpRms * 0.035;
    } else {
      this.noiseHpRms = this.noiseHpRms * 0.995 + Math.min(hpRms, this.noiseHpRms * 2) * 0.005;
    }
    if (rms < this.noiseRms * 2.0) {
      this.noiseRms = this.noiseRms * 0.97 + rms * 0.03;
    }
  }

  private snapshotPreRing(): Float32Array {
    const count = Math.min(this.preCount, this.preSamples);
    const out = new Float32Array(count);
    if (this.preCount < this.preSamples) {
      out.set(this.preRing.subarray(0, count), 0);
    } else {
      const first = this.preSamples - this.preWrite;
      out.set(this.preRing.subarray(this.preWrite), 0);
      out.set(this.preRing.subarray(0, this.preWrite), first);
    }
    return out;
  }

  private writePreRing(input: Float32Array): void {
    for (let i = 0; i < input.length; i++) {
      this.preRing[this.preWrite] = input[i];
      this.preWrite = (this.preWrite + 1) % this.preSamples;
      if (this.preCount < this.preSamples) this.preCount++;
    }
  }

  private appendPending(
    input: Float32Array,
    hpSq: number,
    allSq: number,
    lowSq: number,
    peak: number,
  ): void {
    const p = this.pending;
    if (!p) return;
    const remaining = this.windowSamples - p.writeOffset;
    const toCopy = Math.min(input.length, remaining);
    p.buffer.set(input.subarray(0, toCopy), p.writeOffset);
    p.writeOffset += toCopy;
    p.peak = Math.max(p.peak, peak);
    p.allSq += allSq;
    p.lowSq += lowSq;
    p.highSq += hpSq;
    p.count += input.length;
  }

  private finalize(p: PendingWindow): DetectedStrike | null {
    try {
      const modes = extractModalPeaks(p.buffer, this.sampleRate);
      const rmsLevel = Math.sqrt(p.allSq / Math.max(1, p.count));
      const lowFrequencyEnergy = Math.sqrt(p.lowSq / Math.max(1, p.count));
      const highFrequencyEnergy = Math.sqrt(p.highSq / Math.max(1, p.count));
      const crackScore = rawCrackScore(modes);
      const readySample = this.frame;
      return {
        onsetSample: p.onsetSample,
        readySample,
        algorithmicLatencyMs: ((readySample - p.onsetSample) / this.sampleRate) * 1000,
        sampleRate: this.sampleRate,
        peakLevel: p.peak,
        rmsLevel,
        lowFrequencyEnergy: lowFrequencyEnergy / Math.max(rmsLevel, 1e-6),
        highFrequencyEnergy: highFrequencyEnergy / Math.max(rmsLevel, 1e-6),
        modes,
        crackScore,
        crackDetected: crackScore >= 0.62,
        windowSamples: this.windowSamples,
      };
    } catch (error) {
      console.warn('Hammer analysis failed', error);
      return null;
    }
  }
}

export function rawCrackScore(modes: ModalPeak[]): number {
  if (!modes.length) return 0;
  let score = 0;
  for (const m of modes) {
    if (m.split) {
      score = Math.max(score, 0.62 + Math.min(0.3, (m.splitSeparationHz ?? 30) / 240) + m.irregularity * 0.12);
    } else {
      score = Math.max(score, m.irregularity * 0.58);
    }
  }
  const splitModes = modes.filter((m) => m.split).length;
  if (splitModes >= 2) score = Math.min(1, score + 0.08);
  return Math.max(0, Math.min(1, score));
}

export { rms };
