// 合成锻打测试录音：
//  每一锤 = 锤头宽带瞬态(click) + 砧子回响(anvil ring) + 坯料模态振动(随温度变化)
//  暗裂 = 模态频率分裂 + 拍频 + 不规则衰减
//  环境 = 鼓风机低频轰鸣 + 远处他人锤声（用于验证谱门控）
// 全部确定性可复现（mulberry32 种子），Node 测试与浏览器演示共用。

import type { BilletSize, SteelGrade } from './types.ts';

export const SAMPLE_RATE = 48000;

export interface SteelParams {
  grade: SteelGrade;
  /** 1200°C 参考基频 Hz（中坯基准） */
  baseF1: number;
  /** 泛音频率比（相对基频，梁的弯曲模态近似 1 : 2.76 : 5.4 : 8.9） */
  modeRatios: number[];
}

export const STEEL_PARAMS: Record<SteelGrade, SteelParams> = {
  '1045': { grade: '1045', baseF1: 500, modeRatios: [1, 2.76, 5.4, 8.93] },
  '1095': { grade: '1095', baseF1: 545, modeRatios: [1, 2.76, 5.4, 8.93] },
  'T10': { grade: 'T10', baseF1: 585, modeRatios: [1, 2.76, 5.4, 8.93] },
  'W2': { grade: 'W2', baseF1: 525, modeRatios: [1, 2.76, 5.4, 8.93] },
};

/** 尺寸对基频的缩放（越厚重频率越低）与衰减的影响 */
export const SIZE_PARAMS: Record<BilletSize, { freqScale: number; tauScale: number; label: string }> = {
  small: { freqScale: 1.35, tauScale: 0.8, label: '小坯' },
  medium: { freqScale: 1.0, tauScale: 1.0, label: '中坯' },
  large: { freqScale: 0.72, tauScale: 1.35, label: '大坯' },
};

export interface SynthStrike {
  /** 锤击时间 s */
  time: number;
  temperatureC: number;
  /** 力度 0.5~1.2，影响整体幅度 */
  intensity?: number;
  /** 该锤是否带暗裂 */
  cracked?: boolean;
}

export interface SynthScenario {
  grade: SteelGrade;
  size: BilletSize;
  durationSeconds: number;
  strikes: SynthStrike[];
  /** 鼓风机增益，默认 0.18 */
  blowerLevel?: number;
  /** 远处他人锤声数量，默认 6 */
  distantStrikes?: number;
  /** 环境白噪声增益，默认 0.01 */
  noiseFloor?: number;
  seed?: number;
}

export interface RenderedAudio {
  pcm: Float32Array;
  sampleRate: number;
  /** 真值锤击（不含远处锤声） */
  groundTruth: SynthStrike[];
  /** 远处干扰锤的时间点 */
  distantTimes: number[];
}

/** 确定性 PRNG，保证测试可复现 */
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

/**
 * 温度 → 基频：随温度升高而降低。
 * 以 1200°C 的 baseF1 为基准，每降 100°C 频率约升 5.5%（弹性模量效应的工程近似）。
 */
export function f1AtTemperature(baseF1: number, tempC: number, freqScale: number): number {
  const refTemp = 1200;
  const factorPer100 = 0.055;
  const factor = 1 + ((refTemp - tempC) / 100) * factorPer100;
  return baseF1 * freqScale * factor;
}

/** 温度 → 基频衰减时间常数：越热衰减越快（tau 越小） */
export function tauAtTemperature(tempC: number, tauScale: number, rng: () => number): number {
  // 1200°C 约 18ms，700°C 约 42ms，线性插值 + 轻微随机
  const hot = 0.018 * tauScale;
  const cold = 0.042 * tauScale;
  const t = clamp((1200 - tempC) / 500, 0, 1);
  return hot + (cold - hot) * t + (rng() - 0.5) * 0.002;
}

export function renderScenario(scenario: SynthScenario): RenderedAudio {
  const sr = SAMPLE_RATE;
  const rng = mulberry32(scenario.seed ?? 42);
  const total = Math.round(scenario.durationSeconds * sr);
  const pcm = new Float32Array(total);
  const steel = STEEL_PARAMS[scenario.grade];
  const size = SIZE_PARAMS[scenario.size];

  for (const strike of scenario.strikes) {
    renderStrike(pcm, strike, steel, size, sr, rng);
  }

  const distantTimes = renderDistantStrikes(
    pcm,
    scenario.distantStrikes ?? 6,
    scenario.durationSeconds,
    sr,
    rng,
    scenario.strikes.map((s) => s.time),
  );
  renderBlower(pcm, scenario.blowerLevel ?? 0.18, sr, rng);
  renderNoiseFloor(pcm, scenario.noiseFloor ?? 0.01, rng);

  // 软限幅，避免叠加削波
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.tanh(pcm[i] * 0.9);
  }
  return { pcm, sampleRate: sr, groundTruth: scenario.strikes, distantTimes };
}

function renderStrike(
  pcm: Float32Array,
  strike: SynthStrike,
  steel: SteelParams,
  size: { freqScale: number; tauScale: number },
  sr: number,
  rng: () => number,
): void {
  const startSample = Math.round(strike.time * sr);
  const intensity = strike.intensity ?? 1;
  const f1 = f1AtTemperature(steel.baseF1, strike.temperatureC, size.freqScale);
  const tau1 = tauAtTemperature(strike.temperatureC, size.tauScale, rng);
  const cracked = strike.cracked === true;
  // 最长渲染 0.5s（冷坯衰减也覆盖得到）
  const maxLen = Math.min(Math.round(0.5 * sr), pcm.length - startSample);
  if (maxLen <= 0) return;

  // 各模态幅度：基频最强，泛音依次减弱
  const modeGains = [1.0, 0.55, 0.28, 0.13];

  for (let m = 0; m < steel.modeRatios.length; m++) {
    const f = f1 * steel.modeRatios[m];
    const tau = tau1 * (1 + m * 0.18);
    const gain = 0.32 * intensity * modeGains[m];
    addDampedTone(pcm, startSample, maxLen, f, tau, gain, sr, rng, cracked && m <= 1);
  }

  // 锤头瞬态：短噪声 burst + 低通质感
  addHammerClick(pcm, startSample, maxLen, 0.5 * intensity, sr, rng);
  // 砧子回响：固定的中频低衰减环
  addDampedTone(pcm, startSample, maxLen, 185, 0.11, 0.16 * intensity, sr, rng, false);
  addDampedTone(pcm, startSample, maxLen, 277, 0.08, 0.09 * intensity, sr, rng, false);
}

/** 叠加一个指数衰减正弦；裂纹时分裂为双峰并加入拍频与幅度抖动 */
function addDampedTone(
  pcm: Float32Array,
  start: number,
  len: number,
  freq: number,
  tau: number,
  gain: number,
  sr: number,
  rng: () => number,
  cracked: boolean,
): void {
  const phase0 = rng() * Math.PI * 2;
  if (!cracked) {
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = gain * Math.exp(-t / tau);
      pcm[start + i] += env * Math.sin(2 * Math.PI * freq * t + phase0);
    }
    return;
  }
  // 暗裂：主峰 + 偏移 2.5~4% 的次峰，产生拍频；衰减带随机抖动（忽快忽慢）
  const splitRatio = 1 + (0.025 + rng() * 0.015);
  const f2 = freq * splitRatio;
  const phase1 = rng() * Math.PI * 2;
  const tau2 = tau * (0.7 + rng() * 0.5);
  // 分段衰减率，制造“不规则衰减”
  const break1 = len * 0.3;
  const break2 = len * 0.6;
  const rateJitter = [0.8 + rng() * 0.5, 1.1 + rng() * 0.6, 0.7 + rng() * 0.4];
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    let rate: number;
    if (i < break1) rate = rateJitter[0];
    else if (i < break2) rate = rateJitter[1];
    else rate = rateJitter[2];
    const env1 = gain * Math.exp(-(t * rate) / tau);
    const env2 = gain * 0.75 * Math.exp(-t / tau2);
    const beat = 1 + 0.18 * Math.sin(2 * Math.PI * (f2 - freq) * t);
    pcm[start + i] +=
      env1 * beat * Math.sin(2 * Math.PI * freq * t + phase0) +
      env2 * Math.sin(2 * Math.PI * f2 * t + phase1);
  }
}

/** 锤头 click：2ms 白噪声经单极点低通，套快速衰减包络 */
function addHammerClick(
  pcm: Float32Array,
  start: number,
  len: number,
  gain: number,
  sr: number,
  rng: () => number,
): void {
  const clickLen = Math.min(Math.round(0.004 * sr), len);
  const alpha = 0.35; // 低通系数
  let lp = 0;
  for (let i = 0; i < clickLen; i++) {
    const white = rng() * 2 - 1;
    lp += alpha * (white - lp);
    const t = i / sr;
    const env = gain * Math.exp(-t / 0.0016);
    pcm[start + i] += env * lp;
  }
}

/** 鼓风机：低频正弦轰鸣（含轻微颤音）+ 经过强低通的气流噪声 */
function renderBlower(pcm: Float32Array, level: number, sr: number, rng: () => number): void {
  const f0 = 55 + rng() * 15;
  const f1 = 92 + rng() * 10;
  let lp1 = 0;
  let lp2 = 0;
  for (let i = 0; i < pcm.length; i++) {
    const t = i / sr;
    const white = rng() * 2 - 1;
    // 两级单极点低通，把白噪声压成低频气流声
    lp1 += 0.02 * (white - lp1);
    lp2 += 0.015 * (lp1 - lp2);
    const tremolo = 1 + 0.12 * Math.sin(2 * Math.PI * 3.2 * t);
    const rumble =
      0.7 * Math.sin(2 * Math.PI * f0 * t + 0.3 * Math.sin(2 * Math.PI * 0.7 * t)) +
      0.4 * Math.sin(2 * Math.PI * f1 * t);
    pcm[i] += level * tremolo * (0.75 * rumble + 0.35 * lp2);
  }
}

function renderNoiseFloor(pcm: Float32Array, level: number, rng: () => number): void {
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] += level * (rng() * 2 - 1);
  }
}

/** 远处锤声：低幅度、低低频占比的闷响，时间避开真实锤击 */
function renderDistantStrikes(
  pcm: Float32Array,
  count: number,
  duration: number,
  sr: number,
  rng: () => number,
  realTimes: number[],
): number[] {
  const times: number[] = [];
  let made = 0;
  let guard = 0;
  while (made < count && guard < count * 20) {
    guard++;
    const t = 0.6 + rng() * (duration - 1.2);
    if (realTimes.some((rt) => Math.abs(rt - t) < 0.25)) continue;
    if (times.some((dt) => Math.abs(dt - t) < 0.2)) continue;
    times.push(t);
    made++;
    const start = Math.round(t * sr);
    const len = Math.min(Math.round(0.18 * sr), pcm.length - start);
    const f = 320 + rng() * 120;
    for (let i = 0; i < len; i++) {
      const tt = i / sr;
      const env = 0.05 * Math.exp(-tt / 0.05);
      pcm[start + i] += env * Math.sin(2 * Math.PI * f * tt);
    }
    // 很弱的高频，保证其谱形态与近场锤击不同
    const clickLen = Math.round(0.003 * sr);
    for (let i = 0; i < clickLen && start + i < pcm.length; i++) {
      pcm[start + i] += 0.012 * (rng() * 2 - 1) * Math.exp(-i / (0.001 * sr));
    }
  }
  return times.sort((a, b) => a - b);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
