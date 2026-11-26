import { ANVIL_MODES_HZ, ANVIL_TAU_MS, billetModes, nominalTauMs } from './physics';
import type { BilletSize, SteelProfile } from './types';

export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SynthTruth {
  modesHz: number[];
  tauMs: number[];
  crack: boolean;
  splitSeparationHz?: number;
}

export interface SynthStrikeOptions {
  sampleRate?: number;
  steel: SteelProfile;
  size: BilletSize;
  tempC: number;
  crack?: boolean;
  crackAmount?: number;
  strength?: number;
  seed?: number;
  durationSec?: number;
  distant?: boolean;
}

function addDampedMode(
  out: Float32Array,
  sr: number,
  hz: number,
  tauMs: number,
  amplitude: number,
  rng: () => number,
  splitHz?: [number, number],
  splitAmplitude = 0.7,
): void {
  const phase = rng() * Math.PI * 2;
  const tauSec = tauMs / 1000;
  if (!splitHz) {
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      out[i] += amplitude * Math.exp(-t / tauSec) * Math.sin(2 * Math.PI * hz * t + phase);
    }
    return;
  }

  const [f1, f2] = splitHz;
  const phase2 = rng() * Math.PI * 2;
  const tau2 = tauSec * (0.72 + rng() * 0.55);
  const beatDepth = 0.12 + rng() * 0.22;
  const beatHz = Math.abs(f2 - f1);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const env1 = Math.exp(-t / tauSec);
    const env2 = Math.exp(-t / tau2);
    // A small irregular modulation prevents the split from sounding too clinical.
    const irregular = 1 + beatDepth * Math.sin(2 * Math.PI * beatHz * 0.37 * t + phase2);
    out[i] +=
      amplitude * env1 * irregular * Math.sin(2 * Math.PI * f1 * t + phase) +
      amplitude * splitAmplitude * env2 * Math.sin(2 * Math.PI * f2 * t + phase2);
  }
}

function addHammerHead(out: Float32Array, sr: number, strength: number, rng: () => number): void {
  // Broadband hardened-steel click.
  const noiseLen = Math.floor(sr * 0.018);
  let hpPrev = 0;
  let prevX = 0;
  const hpA = Math.exp((-2 * Math.PI * 1500) / sr);
  for (let i = 0; i < noiseLen; i++) {
    const white = rng() * 2 - 1;
    const hp = hpA * (hpPrev + white - prevX);
    prevX = white;
    hpPrev = hp;
    const t = i / sr;
    out[i] += strength * 0.5 * Math.exp(-t / 0.0028) * hp;
  }

  const clickFreqs = [2350, 3420, 4860, 6320];
  clickFreqs.forEach((f, idx) => {
    const tau = 2.2 + idx * 1.4 + rng() * 2;
    const amp = strength * (0.16 - idx * 0.025);
    addDampedMode(out, sr, f * (1 + (rng() - 0.5) * 0.02), tau, amp, rng);
  });

  // Small low-frequency contact thud.
  addDampedMode(out, sr, 118 + rng() * 24, 16 + rng() * 8, strength * 0.16, rng);
}

function addAnvil(out: Float32Array, sr: number, strength: number, rng: () => number): void {
  ANVIL_MODES_HZ.forEach((f, i) => {
    const detune = 1 + (rng() - 0.5) * 0.008;
    addDampedMode(
      out,
      sr,
      f * detune,
      ANVIL_TAU_MS[i] * (0.8 + rng() * 0.35),
      strength * (0.2 - i * 0.032),
      rng,
    );
  });
}

export function synthesizeStrike(options: SynthStrikeOptions): {
  samples: Float32Array;
  truth: SynthTruth;
} {
  const sr = options.sampleRate ?? 48_000;
  const duration = options.durationSec ?? 0.82;
  const n = Math.floor(sr * duration);
  const out = new Float32Array(n);
  const rng = mulberry32(options.seed ?? hashSeed(JSON.stringify(options)));
  const strength = options.strength ?? 0.9;
  const modes = billetModes(options.size, options.steel, options.tempC).slice(0, 3);
  const taus = modes.map((_, i) => nominalTauMs(options.size, options.steel, options.tempC, i));

  addHammerHead(out, sr, strength, rng);
  addAnvil(out, sr, strength * (options.distant ? 0.35 : 0.85), rng);

  let splitSeparationHz: number | undefined;
  modes.forEach((f, i) => {
    const baseAmp = strength * [0.5, 0.34, 0.22][i] * (0.86 + rng() * 0.22);
    if (options.crack && (i === 0 || (i === 1 && (options.crackAmount ?? 1) > 0.45))) {
      const amount = options.crackAmount ?? 0.75;
      splitSeparationHz = (30 + rng() * 58) * (0.75 + amount * 0.45);
      addDampedMode(
        out,
        sr,
        f,
        taus[i] * 0.82,
        baseAmp,
        rng,
        [f - splitSeparationHz / 2, f + splitSeparationHz / 2],
        0.58 + rng() * 0.35,
      );
    } else {
      addDampedMode(out, sr, f * (1 + (rng() - 0.5) * 0.004), taus[i], baseAmp, rng);
    }
  });

  // Gentle bus compression and peak normalization.
  let peak = 0;
  for (let i = 0; i < n; i++) {
    out[i] = Math.tanh(out[i] * 1.15) / Math.tanh(1.15);
    peak = Math.max(peak, Math.abs(out[i]));
  }
  const targetPeak = options.distant ? 0.16 + rng() * 0.08 : 0.62 + rng() * 0.2;
  const gain = peak > 1e-6 ? targetPeak / peak : 1;
  for (let i = 0; i < n; i++) out[i] *= gain;

  return { samples: out, truth: { modesHz: modes, tauMs: taus, crack: !!options.crack, splitSeparationHz } };
}

export function synthesizeOtherHammer(
  sr: number,
  seed: number,
  level = 0.16,
): Float32Array {
  const rng = mulberry32(seed);
  const duration = 0.65;
  const n = Math.floor(sr * duration);
  const out = new Float32Array(n);

  // Dull, distant attack: lowpass-ish noise and a different anvil tuning.
  const noiseLen = Math.floor(sr * 0.025);
  let lp = 0;
  for (let i = 0; i < noiseLen; i++) {
    const white = rng() * 2 - 1;
    lp += 0.22 * (white - lp);
    const t = i / sr;
    out[i] += level * 2.1 * Math.exp(-t / 0.006) * lp;
  }
  [1240, 1885, 2810, 4215].forEach((f, i) => {
    addDampedMode(out, sr, f * (1 + (rng() - 0.5) * 0.012), 170 + i * 45, level * (0.9 - i * 0.16), rng);
  });

  // Simple feedback echo to imitate reflections from another part of the shop.
  const echo = Math.floor(sr * (0.075 + rng() * 0.05));
  for (let i = echo; i < n; i++) out[i] += out[i - echo] * 0.22;
  return out;
}

export function addBlower(
  buffer: Float32Array,
  sr: number,
  seed: number,
  level = 0.026,
): void {
  const rng = mulberry32(seed);
  let brown = 0;
  let lp = 0;
  const humHz = 48 + rng() * 8;
  const whirrHz = 17 + rng() * 9;
  for (let i = 0; i < buffer.length; i++) {
    const white = rng() * 2 - 1;
    brown = (brown + 0.018 * white) / 1.018;
    lp += 0.035 * (brown * 3.2 - lp);
    const t = i / sr;
    const aerodynamic = 0.65 + 0.35 * Math.sin(2 * Math.PI * whirrHz * t);
    const hum = 0.18 * Math.sin(2 * Math.PI * humHz * t);
    const v = level * (lp * 2.4 * aerodynamic + hum + white * 0.08);
    buffer[i] += v;
  }
}

export interface SequenceStrikeSpec {
  atSec: number;
  tempC: number;
  crack: boolean;
  strength?: number;
}

export interface SyntheticSequenceOptions {
  sampleRate?: number;
  steel: SteelProfile;
  size: BilletSize;
  strikes: SequenceStrikeSpec[];
  durationSec?: number;
  blowerLevel?: number;
  otherHammers?: Array<{ atSec: number; level?: number }>;
  seed?: number;
}

export function synthesizeSequence(options: SyntheticSequenceOptions): {
  samples: Float32Array;
  truths: Array<{ onsetSample: number; tempC: number; crack: boolean }>;
} {
  const sr = options.sampleRate ?? 48_000;
  const lastStrike = options.strikes[options.strikes.length - 1]?.atSec ?? 0;
  const duration = options.durationSec ?? lastStrike + 0.9;
  const total = Math.floor(sr * duration);
  const mix = new Float32Array(total);
  const seed = options.seed ?? 1;

  if (options.blowerLevel && options.blowerLevel > 0) {
    addBlower(mix, sr, seed ^ 0x9e3779b9, options.blowerLevel);
  }

  const truths = options.strikes.map((s, i) => {
    const { samples } = synthesizeStrike({
      sampleRate: sr,
      steel: options.steel,
      size: options.size,
      tempC: s.tempC,
      crack: s.crack,
      strength: s.strength ?? 0.86 + ((seed + i * 17) % 10) / 90,
      seed: seed + i * 1013,
    });
    const onsetSample = Math.floor(s.atSec * sr);
    for (let j = 0; j < samples.length && onsetSample + j < total; j++) {
      mix[onsetSample + j] += samples[j];
    }
    return { onsetSample, tempC: s.tempC, crack: s.crack };
  });

  options.otherHammers?.forEach((h, i) => {
    const clip = synthesizeOtherHammer(sr, seed + 5000 + i * 97, h.level ?? 0.15);
    const start = Math.floor(h.atSec * sr);
    for (let j = 0; j < clip.length && start + j < total; j++) {
      mix[start + j] += clip[j];
    }
  });

  // Consistent monitoring peak without changing relative strike/noise ratio much.
  let peak = 0;
  for (const v of mix) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.97) {
    const g = 0.97 / peak;
    for (let i = 0; i < mix.length; i++) mix[i] *= g;
  }
  return { samples: mix, truths };
}
