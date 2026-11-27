// 流式分析管线：OnsetDetector + FeatureExtractor 的串联驱动。
// AudioWorklet 实时线程和 Node 验收测试都通过这个类跑，
// 保证“线上跑的算法”和“验收测的算法”是同一份代码。

import { FeatureExtractor } from './features.ts';
import { OnsetDetector } from './onset.ts';
import type { StrikeFeatures } from './types.ts';

export interface StreamAnalyzerConfig {
  sampleRate: number;
  spectralGateEnabled?: boolean;
}

export interface StreamAnalyzerCallbacks {
  onStrike: (features: StrikeFeatures) => void;
  /** 轻量 onset 事件：锤击瞬间立刻发出，用于把界面反馈压到 100ms 内 */
  onOnset?: (sample: number, time: number) => void;
  onIgnored?: (sample: number, time: number, reason: string) => void;
  onLevel?: (rms: number) => void;
}

const RING_SECONDS = 1.2;

export class StreamAnalyzer {
  readonly sampleRate: number;
  private readonly detector: OnsetDetector;
  private readonly extractor: FeatureExtractor;
  private readonly ring: Float32Array;
  private ringWrite = 0;
  private totalSamples = 0;
  /** 已确认但分析窗口尚未攒满的 onset */
  private readonly pending: number[] = [];
  private onsetReadPos = 0;
  private ignoredReadPos = 0;
  private readonly callbacks: StreamAnalyzerCallbacks;
  private levelAccum = 0;
  private levelCount = 0;
  private lastLevelReport = 0;
  private readonly windowSamples: number;

  constructor(config: StreamAnalyzerConfig, callbacks: StreamAnalyzerCallbacks) {
    this.sampleRate = config.sampleRate;
    this.callbacks = callbacks;
    this.detector = new OnsetDetector({
      sampleRate: config.sampleRate,
      spectralGateEnabled: config.spectralGateEnabled ?? true,
    });
    this.extractor = new FeatureExtractor({ sampleRate: config.sampleRate });
    this.windowSamples = Math.round(this.extractor.windowSeconds * config.sampleRate);
    this.ring = new Float32Array(Math.ceil(RING_SECONDS * config.sampleRate));
  }

  setSpectralGate(enabled: boolean): void {
    this.detector.spectralGateEnabled = enabled;
  }

  /** 处理一块 PCM（实时麦克风或离线合成信号都走这里） */
  process(block: Float32Array): void {
    for (let i = 0; i < block.length; i++) {
      this.ring[this.ringWrite] = block[i];
      this.ringWrite = (this.ringWrite + 1) % this.ring.length;
    }
    this.totalSamples += block.length;

    this.detector.process(block);

    // 电平表（每 ~100ms 报一次）
    for (let i = 0; i < block.length; i++) this.levelAccum += block[i] * block[i];
    this.levelCount += block.length;
    if (this.totalSamples - this.lastLevelReport >= 0.1 * this.sampleRate) {
      const rms = Math.sqrt(this.levelAccum / Math.max(1, this.levelCount));
      this.callbacks.onLevel?.(rms);
      this.levelAccum = 0;
      this.levelCount = 0;
      this.lastLevelReport = this.totalSamples;
    }

    // 只消费新增的 onset / ignored 事件
    while (this.onsetReadPos < this.detector.onsets.length) {
      const ev = this.detector.onsets[this.onsetReadPos++];
      this.pending.push(ev.sample);
      this.callbacks.onOnset?.(ev.sample, ev.time);
    }
    while (this.ignoredReadPos < this.detector.ignored.length) {
      const ig = this.detector.ignored[this.ignoredReadPos++];
      this.callbacks.onIgnored?.(ig.sample, ig.time, ig.reason);
    }

    // 攒够分析窗口就出特征
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const onsetSample = this.pending[i];
      if (this.totalSamples - onsetSample >= this.windowSamples) {
        const features = this.extractFromRing(onsetSample);
        this.callbacks.onStrike(features);
        this.pending.splice(i, 1);
      }
    }
  }

  private extractFromRing(onsetSample: number): StrikeFeatures {
    const segment = new Float32Array(this.windowSamples);
    const newestGlobal = this.totalSamples - 1;
    for (let i = 0; i < this.windowSamples; i++) {
      const globalIdx = onsetSample + i;
      const age = newestGlobal - globalIdx;
      const pos = (this.ringWrite - 1 - age + this.ring.length * 2) % this.ring.length;
      segment[i] = this.ring[pos];
    }
    // segment 即以 onset 为起点的信号，从零位提取，时间戳由 onsetSample 还原
    return this.extractor.extract(segment, 0, onsetSample);
  }

  /** 流结束时冲刷：未满足窗口的锤击用零填充补算 */
  flush(): StrikeFeatures[] {
    this.detector.flush();
    while (this.onsetReadPos < this.detector.onsets.length) {
      const ev = this.detector.onsets[this.onsetReadPos++];
      this.pending.push(ev.sample);
      this.callbacks.onOnset?.(ev.sample, ev.time);
    }
    const leftover: StrikeFeatures[] = [];
    for (const onsetSample of this.pending) {
      leftover.push(this.extractFromRing(onsetSample));
    }
    this.pending.length = 0;
    return leftover;
  }
}
