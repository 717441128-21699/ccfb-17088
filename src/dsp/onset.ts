// 锤击起始（onset）检测器：
//  - 滑动短帧 RMS + 频谱通量（spectral flux，主判据）
//  - 自适应噪声底（one-pole EMA，仅在非击发段更新）
//  - 谱门控：用低频占比/高频瞬态区分真实锤击与鼓风机、远处锤声
//  - 不应期保证 3 锤/秒（间隔 333ms）也能逐锤分开
// 同一份实现跑在 AudioWorklet 与 Node 验收测试里。

import { fft, hannWindow } from './fft.ts';

export interface OnsetEvent {
  /** 相对整条流的采样序号（精确到帧内峰值定位） */
  sample: number;
  time: number;
  rms: number;
}

export interface IgnoredEvent {
  sample: number;
  time: number;
  reason: string;
}

export interface OnsetDetectorConfig {
  sampleRate: number;
  frameSize?: number;
  hopSize?: number;
  /** 绝对 RMS 下限，避免静音误触发 */
  absoluteRmsFloor?: number;
  /** 谱通量相对其滑动均值的倍数阈值（主判据） */
  fluxRatioThreshold?: number;
  /** 谱通量绝对值下限（相对校准背景） */
  fluxAbsRatio?: number;
  /** 不应期（秒），两锤最小间隔 */
  refractorySeconds?: number;
  /** 背景自适应时间常数（秒） */
  noiseTauSeconds?: number;
  /** 谱门控开关 */
  spectralGateEnabled?: boolean;
}

const DEFAULTS = {
  frameSize: 512,
  hopSize: 128,
  absoluteRmsFloor: 0.08,
  fluxRatioThreshold: 1.6,
  fluxAbsRatio: 2.2,
  refractorySeconds: 0.11,
  noiseTauSeconds: 1.5,
  spectralGateEnabled: true,
};

export class OnsetDetector {
  readonly sampleRate: number;
  readonly frameSize: number;
  readonly hopSize: number;
  spectralGateEnabled: boolean;

  private readonly absoluteRmsFloor: number;
  private readonly fluxRatioThreshold: number;
  private readonly fluxAbsRatio: number;
  private readonly refractorySamples: number;
  private readonly noiseAlpha: number;

  private readonly ring: Float32Array;
  private ringWrite = 0;
  private ringFilled = 0;
  private readonly frame: Float32Array;
  private readonly window: Float32Array;
  private readonly fftRe: Float32Array;
  private readonly fftIm: Float32Array;
  private readonly prevMag: Float32Array;
  private readonly fluxHistory: number[] = [];
  private readonly fluxHistoryLen: number;

  private totalSamples = 0;
  private nextFrameStart = 0;
  private calibrated = false;
  private calibrationFrames = 0;
  private readonly calibrationTarget: number;
  private noiseRms = 0;
  private noiseFlux = 0;
  private lastOnsetSample = -Infinity;
  /** 待谱门控复核的候选（延后约 40ms 做最终确认） */
  private pendingCandidate: { sample: number; rms: number; checkAt: number } | null = null;

  readonly onsets: OnsetEvent[] = [];
  readonly ignored: IgnoredEvent[] = [];

  constructor(config: OnsetDetectorConfig) {
    const cfg = { ...DEFAULTS, ...config };
    this.sampleRate = cfg.sampleRate;
    this.frameSize = cfg.frameSize;
    this.hopSize = cfg.hopSize;
    this.absoluteRmsFloor = cfg.absoluteRmsFloor;
    this.fluxRatioThreshold = cfg.fluxRatioThreshold;
    this.fluxAbsRatio = cfg.fluxAbsRatio;
    this.refractorySamples = Math.round(cfg.refractorySeconds * cfg.sampleRate);
    this.noiseAlpha = this.hopSize / (cfg.noiseTauSeconds * cfg.sampleRate);
    this.spectralGateEnabled = cfg.spectralGateEnabled;

    // 环形缓冲保留约 1 秒历史，用于回溯 onset 前导样本与门控复核
    const ringSize = cfg.sampleRate;
    this.ring = new Float32Array(ringSize);
    this.frame = new Float32Array(this.frameSize);
    this.window = hannWindow(this.frameSize);
    this.fftRe = new Float32Array(this.frameSize);
    this.fftIm = new Float32Array(this.frameSize);
    this.prevMag = new Float32Array(this.frameSize / 2);
    this.fluxHistoryLen = 40;
    this.calibrationTarget = Math.round((0.2 * cfg.sampleRate) / this.hopSize);
  }

  /** 处理一个 128 样本（AudioWorklet 量子）或任意长度的音频块 */
  process(block: Float32Array): void {
    for (let i = 0; i < block.length; i++) {
      this.ring[this.ringWrite] = block[i];
      this.ringWrite = (this.ringWrite + 1) % this.ring.length;
      this.ringFilled = Math.min(this.ringFilled + 1, this.ring.length);
      this.totalSamples++;

      if (this.totalSamples - this.nextFrameStart >= this.hopSize) {
        this.nextFrameStart += this.hopSize;
        this.processFrame();
      }
    }
  }

  /** 离线测试结束时调用，强制完成待复核候选 */
  flush(): void {
    if (this.pendingCandidate) {
      const c = this.pendingCandidate;
      this.pendingCandidate = null;
      this.confirmOrReject(c.sample, c.rms);
    }
  }

  private readRingInto(endSample: number, out: Float32Array): void {
    const start = endSample - out.length;
    for (let i = 0; i < out.length; i++) {
      const globalIdx = start + i;
      if (globalIdx < 0 || this.ringFilled === 0) {
        out[i] = 0;
      } else {
        const ringPos = (this.ringWrite - (this.totalSamples - globalIdx) + this.ring.length) % this.ring.length;
        out[i] = this.ring[ringPos];
      }
    }
  }

  private processFrame(): void {
    const frameEnd = this.nextFrameStart;
    if (frameEnd < this.frameSize) return;
    this.readRingInto(frameEnd, this.frame);

    // ---- 1. 短时 RMS（绝对门，排除远处弱声） ----
    let sumSq = 0;
    for (let i = 0; i < this.frameSize; i++) sumSq += this.frame[i] * this.frame[i];
    const rms = Math.sqrt(sumSq / this.frameSize);

    // ---- 2. 加窗 FFT，计算频谱通量（主判据：冲击瞬态） ----
    for (let i = 0; i < this.frameSize; i++) {
      this.fftRe[i] = this.frame[i] * this.window[i];
      this.fftIm[i] = 0;
    }
    fft(this.fftRe, this.fftIm);
    const half = this.frameSize / 2;
    let flux = 0;
    for (let k = 1; k < half; k++) {
      const mag = Math.hypot(this.fftRe[k], this.fftIm[k]);
      const delta = mag - this.prevMag[k];
      if (delta > 0) flux += delta;
      this.prevMag[k] = mag;
    }
    flux /= half;

    // ---- 3. 背景统计校准 / 自适应 ----
    if (!this.calibrated) {
      this.calibrationFrames++;
      this.noiseRms += rms;
      this.noiseFlux += flux;
      this.fluxHistory.push(flux);
      if (this.calibrationFrames >= this.calibrationTarget) {
        this.noiseRms /= this.calibrationFrames;
        this.noiseFlux /= this.calibrationFrames;
        this.calibrated = true;
      }
      return;
    }

    const fluxMean = this.averageFlux();
    const fluxBaseline = Math.max(this.noiseFlux, fluxMean * 0.5);
    // 主判据：通量相对背景显著跃升；辅助：RMS 达到近场锤击的绝对量级
    const fluxTrigger =
      flux > fluxBaseline * this.fluxRatioThreshold &&
      flux > this.noiseFlux * this.fluxAbsRatio;
    const rmsGate = rms > this.absoluteRmsFloor;
    const inRefractory = frameEnd - this.lastOnsetSample < this.refractorySamples;

    if (fluxTrigger && rmsGate && !inRefractory && !this.pendingCandidate) {
      // 候选：延后 20ms 等打击瞬态成形，再用谱门控复核
      const onsetSample = this.locatePeakWithin(frameEnd);
      this.pendingCandidate = {
        sample: onsetSample,
        rms,
        checkAt: frameEnd + Math.round(0.02 * this.sampleRate),
      };
    } else if (this.pendingCandidate && frameEnd >= this.pendingCandidate.checkAt) {
      const c = this.pendingCandidate;
      this.pendingCandidate = null;
      this.confirmOrReject(c.sample, c.rms);
    }

    // 非击发状态下让噪声底缓慢跟随环境变化
    if (!this.pendingCandidate) {
      this.noiseRms += this.noiseAlpha * (rms - this.noiseRms);
      this.noiseFlux += this.noiseAlpha * (flux - this.noiseFlux);
      this.fluxHistory.push(flux);
      if (this.fluxHistory.length > this.fluxHistoryLen) this.fluxHistory.shift();
    }
  }

  private averageFlux(): number {
    if (this.fluxHistory.length === 0) return this.noiseFlux;
    let s = 0;
    for (const v of this.fluxHistory) s += v;
    return s / this.fluxHistory.length;
  }

  /** 在触发帧内回溯，把 onset 定位到短时能量最大的子区间 */
  private locatePeakWithin(frameEnd: number): number {
    const sub = 64;
    let best = frameEnd - this.frameSize;
    let bestPower = -1;
    const start = frameEnd - this.frameSize;
    for (let s = start; s + sub <= frameEnd; s += sub) {
      let power = 0;
      for (let i = 0; i < sub; i++) {
        const globalIdx = s + i;
        const ringPos =
          (this.ringWrite - (this.totalSamples - globalIdx) + this.ring.length) % this.ring.length;
        const v = this.ringFilled ? this.ring[ringPos] : 0;
        power += v * v;
      }
      if (power > bestPower) {
        bestPower = power;
        best = s;
      }
    }
    return best;
  }

  private confirmOrReject(sample: number, rms: number): void {
    if (sample - this.lastOnsetSample < this.refractorySamples) return;
    if (this.spectralGateEnabled && !this.passesSpectralGate(sample)) {
      this.ignored.push({
        sample,
        time: sample / this.sampleRate,
        reason: 'spectral-gate: 低频冲击占比不足（疑似鼓风机/远处锤声）',
      });
      return;
    }
    this.lastOnsetSample = sample;
    this.onsets.push({ sample, time: sample / this.sampleRate, rms });
  }

  /**
   * 谱门控：真实近场锤击是宽频脉冲 + 强烈的低频结构振动，
   * 鼓风机以低频窄带轰鸣为主、高频冲击能量弱，远处锤声整体能量低且高频瞬态弱。
   * 采样窗从 onset 点开始，确保锤头瞬态（约 4ms）还在窗内。
   */
  private passesSpectralGate(onsetSample: number): boolean {
    const gateFrame = this.frameSize;
    const end = onsetSample + gateFrame;
    const buf = new Float32Array(gateFrame);
    this.readRingInto(end, buf);
    const re = new Float32Array(gateFrame);
    const im = new Float32Array(gateFrame);
    for (let i = 0; i < gateFrame; i++) {
      re[i] = buf[i] * this.window[i];
    }
    fft(re, im);
    const binHz = this.sampleRate / gateFrame;
    let lowE = 0; // 200~900 Hz：坯料结构振动 + 砧子回响
    let highE = 0; // 1.5k~8k：锤头瞬态
    let rumbleE = 0; // <120 Hz：鼓风机轰鸣
    let total = 0;
    for (let k = 1; k < gateFrame / 2; k++) {
      const f = k * binHz;
      const e = re[k] * re[k] + im[k] * im[k];
      total += e;
      if (f >= 200 && f <= 900) lowE += e;
      if (f >= 1500 && f <= 8000) highE += e;
      if (f < 120) rumbleE += e;
    }
    if (total === 0) return false;
    const lowRatio = lowE / total;
    const highRatio = highE / total;
    const rumbleRatio = rumbleE / total;
    // 实测谱形态（合成录音标定）：
    //   鼓风机：rumble≈0.85、high<0.01；远处锤声：high<0.01；真锤：high 0.14~0.26
    if (highRatio < 0.025) return false;
    // 轰鸣占主导且结构带缺失，判为鼓风机
    if (rumbleRatio > 0.75 && lowRatio < 0.08) return false;
    return lowRatio > 0.08;
  }
}
