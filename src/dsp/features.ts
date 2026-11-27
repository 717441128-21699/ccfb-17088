// 锤击特征提取：
//  - 对 onset 之后固定窗口做 FFT，找坯料振动模态（基频 f1 + 泛音）
//  - 抛物线插值做亚 bin 测频
//  - 频率分裂检测（同模态邻域出现双峰）
//  - Goertzel 逐子帧测幅 → log 线性拟合求衰减时间常数 tau
//  - 包络不规则度 + 分裂 → 暗裂综合评分
// 与合成器、验收测试共用同一份实现。

import { fft, goertzelMagnitude, hannWindow, parabolicInterpolation } from './fft.ts';
import type { ModeFeatures, StrikeFeatures } from './types.ts';

export interface FeatureExtractorConfig {
  sampleRate: number;
  /** 分析窗口秒数（决定端到端延迟的主体） */
  windowSeconds?: number;
  fftSize?: number;
  minModeHz?: number;
  maxModeHz?: number;
  maxModes?: number;
  /** 分裂峰最小相对间距 */
  splitMinRelSeparation?: number;
  /** 分裂峰最小相对幅值 */
  splitMinRelAmplitude?: number;
  /** 暗裂判定阈值 */
  crackThreshold?: number;
}

const DEFAULT_CFG = {
  // 48ms 分析窗：配合 20ms 门控复核，端到端约 72ms（<100ms 指标，留足调度余量）
  windowSeconds: 0.048,
  // 16384 点零填充：bin≈2.93Hz，能解析大坯低频模态上 11~17Hz 的裂纹分裂
  fftSize: 16384,
  // 下限 300Hz：覆盖大坯热态基频（约 360Hz），仍高于砧子回响 277Hz
  minModeHz: 300,
  maxModeHz: 4200,
  maxModes: 4,
  splitMinRelSeparation: 0.008,
  splitMinRelAmplitude: 0.3,
  crackThreshold: 0.3,
};

interface RawPeak {
  frequency: number;
  magnitude: number;
  bin: number;
}

export class FeatureExtractor {
  readonly sampleRate: number;
  readonly windowSeconds: number;
  readonly fftSize: number;
  readonly crackThreshold: number;
  private readonly minModeHz: number;
  private readonly maxModeHz: number;
  private readonly maxModes: number;
  private readonly splitMinRelSeparation: number;
  private readonly splitMinRelAmplitude: number;
  private readonly windowSamples: number;
  private readonly windowFn: Float32Array;
  private readonly fftRe: Float32Array;
  private readonly fftIm: Float32Array;

  constructor(config: FeatureExtractorConfig) {
    const cfg = { ...DEFAULT_CFG, ...config };
    this.sampleRate = cfg.sampleRate;
    this.windowSeconds = cfg.windowSeconds;
    this.fftSize = cfg.fftSize;
    this.minModeHz = cfg.minModeHz;
    this.maxModeHz = cfg.maxModeHz;
    this.maxModes = cfg.maxModes;
    this.splitMinRelSeparation = cfg.splitMinRelSeparation;
    this.splitMinRelAmplitude = cfg.splitMinRelAmplitude;
    this.crackThreshold = cfg.crackThreshold;
    this.windowSamples = Math.round(cfg.windowSeconds * cfg.sampleRate);
    this.windowFn = hannWindow(this.windowSamples);
    this.fftRe = new Float32Array(cfg.fftSize);
    this.fftIm = new Float32Array(cfg.fftSize);
  }

  /**
   * 从完整 PCM 中提取一锤的特征。
   * @param signal 整条音频（或以 onset 为起点的切片，此时传 onsetSample=0）
   * @param onsetSample 锤击起始采样点（切片传 0，真实时间戳由 baseSample 提供）
   * @param baseSample 当 signal 为切片时，切片首样本在整条流中的采样序号
   */
  extract(
    signal: Float32Array,
    onsetSample: number,
    baseSample = 0,
  ): StrikeFeatures {
    const sr = this.sampleRate;
    const n = this.windowSamples;
    const segment = new Float32Array(n);
    const end = Math.min(onsetSample + n, signal.length);
    let rmsPeak = 0;
    // 起始后 8ms 的峰值 RMS，作为锤击强度
    const peakLen = Math.min(Math.round(0.008 * sr), end - onsetSample);
    let peakSq = 0;
    for (let i = 0; i < n; i++) {
      const idx = onsetSample + i;
      const v = idx < end ? signal[idx] : 0;
      segment[i] = v * this.windowFn[i];
      if (i < peakLen && idx < end) peakSq += v * v;
    }
    rmsPeak = peakLen > 0 ? Math.sqrt(peakSq / peakLen) : 0;

    // ---- FFT 找模态峰 ----
    this.fftRe.fill(0);
    this.fftIm.fill(0);
    this.fftRe.set(segment);
    fft(this.fftRe, this.fftIm);
    const half = this.fftSize / 2;
    const binHz = sr / this.fftSize;
    const mag = new Float32Array(half);
    for (let k = 0; k < half; k++) mag[k] = Math.hypot(this.fftRe[k], this.fftIm[k]);

    const minBin = Math.max(2, Math.floor(this.minModeHz / binHz));
    const maxBin = Math.min(half - 2, Math.ceil(this.maxModeHz / binHz));
    const peaks = this.findPeaks(mag, minBin, maxBin, binHz);

    // ---- 组装模态；每个模态在其局部邻域内做高分辨率分裂检测 ----
    const rawSegment = this.rawSegment(signal, onsetSample);
    const modes: ModeFeatures[] = [];
    let splitDetected = false;
    for (const peak of peaks) {
      if (modes.length >= this.maxModes) break;
      // 与已收录模态过近（<6%）的峰属于同一模态簇，跳过
      if (modes.some((m) => Math.abs(m.frequency - peak.frequency) / m.frequency < 0.06)) {
        continue;
      }
      const env = this.measureEnvelope(rawSegment, peak.frequency);
      const mode: ModeFeatures = {
        frequency: peak.frequency,
        amplitude: env.amplitude,
        tau: env.tau,
      };
      // 局部双峰检测：裂纹分裂间距可能只有 1~2 个 FFT bin
      const split = this.detectLocalSplit(mag, peak, binHz, rawSegment);
      if (split) {
        mode.splitPeak = split;
        splitDetected = true;
      }
      modes.push(mode);
    }

    // ---- 暗裂：包络不规则度 + 时域拍频 ----
    const baseFreq = modes.length > 0 ? modes[0].frequency : 0;
    const envelope = baseFreq > 0
      ? this.envelopeTrace(this.rawSegment(signal, onsetSample), baseFreq)
      : [];
    const fitResidual = envelope.length > 4
      ? this.logFitResidual(envelope)
      : 1;
    // 拍频强度：裂纹双峰在基频包络上产生周期性强弱起伏
    const beatStrength = envelope.length > 5
      ? this.beatDetection(envelope)
      : 0;
    const irregularDecay = fitResidual > 0.32;

    const splitScore = splitDetected ? this.scoreSplit(modes) : 0;
    // 三路证据融合：频谱分裂是暗裂的主证据（要求频率真的裂成双峰），
    // 拍频与包络残差只在分裂成立时起加权作用，不单独触发（短窗内正常锤也有包络起伏）
    const crackScore = clamp01(
      splitDetected
        ? 0.7 * splitScore + 0.18 * beatStrength + 0.12 * clamp01(fitResidual / 0.5)
        : 0.15 * beatStrength + 0.1 * clamp01(fitResidual / 0.5),
    );
    const crackSuspected = splitDetected && crackScore >= this.crackThreshold;

    const f1 = modes[0]?.frequency ?? 0;
    const tau1 = modes[0]?.tau ?? 0;

    return {
      onsetSample: baseSample + onsetSample,
      onsetTime: (baseSample + onsetSample) / sr,
      rmsPeak,
      modes,
      f1,
      tau1,
      crackScore,
      crackSuspected,
      irregularDecay,
      splitDetected,
      fitResidual,
      beatStrength,
    };
  }

  private rawSegment(signal: Float32Array, onsetSample: number): Float32Array {
    const out = new Float32Array(this.windowSamples);
    const end = Math.min(onsetSample + this.windowSamples, signal.length);
    for (let i = 0; i < this.windowSamples; i++) {
      const idx = onsetSample + i;
      out[i] = idx < end ? signal[idx] : 0;
    }
    return out;
  }

  private findPeaks(
    mag: Float32Array,
    minBin: number,
    maxBin: number,
    binHz: number,
  ): RawPeak[] {
    const candidates: RawPeak[] = [];
    for (let k = minBin; k <= maxBin; k++) {
      if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] > 1e-6) {
        const refined = parabolicInterpolation(mag, k, binHz);
        candidates.push({ frequency: refined.frequency, magnitude: refined.magnitude, bin: k });
      }
    }
    // 按频率从低到高处理：坯料基频是最低频的“强”模态，
    // 砧子回响(185/277Hz)在 minModeHz(250) 以下或幅值更弱，不能抢占 f1。
    candidates.sort((a, b) => a.frequency - b.frequency);
    const strongest = candidates.reduce((m, c) => Math.max(m, c.magnitude), 1e-9);
    const prominenceFloor = strongest * 0.12;
    const chosen: RawPeak[] = [];
    const minGapHz = 90;
    for (const c of candidates) {
      if (c.magnitude < prominenceFloor) continue;
      if (chosen.every((p) => Math.abs(p.frequency - c.frequency) > minGapHz)) {
        chosen.push(c);
      }
      if (chosen.length >= this.maxModes + 2) break;
    }
    return chosen;
  }

  /**
   * 局部频率分裂检测：
   * 在主峰 ±6% 邻域内寻找第二峰，要求：
   *  - 间距达到最小相对间距（且至少 1.5 个 FFT bin，避免插值伪峰）
   *  - 两峰之间存在明显凹陷（谷值 < 主峰 82%），单平滑峰没有凹陷
   *  - 次峰幅值达到主峰的 splitMinRelAmplitude
   */
  private detectLocalSplit(
    mag: Float32Array,
    peak: RawPeak,
    binHz: number,
    rawSegment: Float32Array,
  ): ModeFeatures['splitPeak'] {
    const centerBin = peak.bin;
    const span = Math.max(3, Math.round(centerBin * 0.06));
    const lo = Math.max(2, centerBin - span);
    const hi = Math.min(mag.length - 2, centerBin + span);

    let second: { bin: number; magnitude: number } | null = null;
    for (let k = lo; k <= hi; k++) {
      if (k === centerBin) continue;
      if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) {
        if (!second || mag[k] > second.magnitude) second = { bin: k, magnitude: mag[k] };
      }
    }
    if (!second) return undefined;
    const relAmp = second.magnitude / peak.magnitude;
    const sepBins = Math.abs(second.bin - centerBin);
    const sepHz = sepBins * binHz;
    if (relAmp < this.splitMinRelAmplitude) return undefined;
    if (sepHz / peak.frequency < this.splitMinRelSeparation) return undefined;
    if (sepBins < 1.5) return undefined;

    // 两峰之间的谷值：真双峰有明显凹陷，单平滑峰没有
    let valley = Infinity;
    const from = Math.min(centerBin, second.bin);
    const to = Math.max(centerBin, second.bin);
    for (let k = from + 1; k < to; k++) valley = Math.min(valley, mag[k]);
    if (!isFinite(valley)) valley = Math.min(peak.magnitude, second.magnitude);
    if (valley > peak.magnitude * 0.82) return undefined;

    const refined = parabolicInterpolation(mag, second.bin, binHz);
    const env = this.measureEnvelope(rawSegment, refined.frequency);
    return {
      frequency: refined.frequency,
      amplitude: env.amplitude,
      tau: env.tau,
      separation: Math.abs(refined.frequency - peak.frequency),
    };
  }

  /** Goertzel 逐子帧测幅，log 线性拟合求 tau；返回起始幅度与 tau(s) */
  private measureEnvelope(
    segment: Float32Array,
    frequency: number,
  ): { amplitude: number; tau: number } {
    const sr = this.sampleRate;
    // 跳过前 4ms（锤头瞬态），之后每 6ms 取一个子帧
    const skip = Math.round(0.004 * sr);
    const subLen = Math.round(0.006 * sr);
    const step = Math.round(0.005 * sr);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let start = skip; start + subLen <= segment.length; start += step) {
      const sub = segment.subarray(start, start + subLen);
      const a = goertzelMagnitude(sub, frequency, sr);
      if (a > 1e-7) {
        xs.push((start + subLen / 2) / sr);
        ys.push(Math.log(a));
      }
    }
    if (xs.length < 3) {
      return { amplitude: 0, tau: 0.02 };
    }
    const { slope, intercept } = linearFit(xs, ys);
    // y = log A - t/tau  → slope = -1/tau
    const tau = slope < -0.5 ? -1 / slope : 0.5;
    return { amplitude: Math.exp(intercept), tau };
  }

  /** 供不规则度评估的完整包络轨迹（时间 s, log 幅度） */
  private envelopeTrace(segment: Float32Array, frequency: number): { t: number; logA: number }[] {
    const sr = this.sampleRate;
    const skip = Math.round(0.004 * sr);
    const subLen = Math.round(0.006 * sr);
    const step = Math.round(0.004 * sr);
    const out: { t: number; logA: number }[] = [];
    for (let start = skip; start + subLen <= segment.length; start += step) {
      const sub = segment.subarray(start, start + subLen);
      const a = goertzelMagnitude(sub, frequency, sr);
      if (a > 1e-7) out.push({ t: (start + subLen / 2) / sr, logA: Math.log(a) });
    }
    return out;
  }

  /** 归一化的 log 包络拟合残差（含二阶曲率，裂纹会让包络忽快忽慢） */
  private logFitResidual(trace: { t: number; logA: number }[]): number {
    const xs = trace.map((p) => p.t);
    const ys = trace.map((p) => p.logA);
    const { slope, intercept } = linearFit(xs, ys);
    let residSq = 0;
    let totalSq = 0;
    const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
    for (let i = 0; i < xs.length; i++) {
      residSq += (ys[i] - (slope * xs[i] + intercept)) ** 2;
      totalSq += (ys[i] - yMean) ** 2;
    }
    const rmse = Math.sqrt(residSq / xs.length);
    // 用斜率绝对值归一：正常指数衰减的 rmse/|slope| 很小
    const normalized = Math.abs(slope) > 1e-6 ? rmse / Math.abs(slope) : 1;
    return Math.min(1.5, normalized);
  }

  /**
   * 时域拍频检测：
   * 先把 log 包络去线性趋势，再看残差是否呈现“峰-谷”交替的周期起伏。
   * 单峰指数衰减去趋势后残差近似平坦；裂纹双峰产生的拍频会留下明显起伏。
   * 返回 0~1 的拍频强度。
   */
  private beatDetection(trace: { t: number; logA: number }[]): number {
    const xs = trace.map((p) => p.t);
    const ys = trace.map((p) => p.logA);
    const { slope, intercept } = linearFit(xs, ys);
    const detrended = ys.map((y, i) => y - (slope * xs[i] + intercept));
    const meanAbs = avg(detrended.map((v) => Math.abs(v))) || 1e-9;
    const norm = detrended.map((v) => v / meanAbs);

    // 统计相邻采样的符号翻转次数（拍频 → 周期性过零）
    let signChanges = 0;
    for (let i = 1; i < norm.length; i++) {
      if ((norm[i - 1] >= 0) !== (norm[i] >= 0) && Math.abs(norm[i] - norm[i - 1]) > 0.6) {
        signChanges++;
      }
    }
    // 起伏的最大峰谷差（归一化后），拍频信号通常 >1.2
    let maxSwing = 0;
    for (let i = 1; i < norm.length; i++) {
      maxSwing = Math.max(maxSwing, Math.abs(norm[i] - norm[i - 1]));
    }
    const swingScore = clamp01((maxSwing - 0.8) / 1.2);
    const flipScore = clamp01((signChanges - 1) / 4);
    return clamp01(0.6 * swingScore + 0.4 * flipScore);
  }

  private scoreSplit(modes: ModeFeatures[]): number {
    let best = 0;
    for (const m of modes) {
      if (!m.splitPeak) continue;
      const relAmp = m.splitPeak.amplitude / (m.amplitude || 1);
      // 双峰越对称、间距越明显，得分越高
      best = Math.max(best, clamp01(relAmp) * 0.7 + clamp01(m.splitPeak.separation / (m.frequency * 0.05)) * 0.3);
    }
    return best;
  }
}

function linearFit(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}
