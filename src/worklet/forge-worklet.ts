// AudioWorklet 处理器：麦克风音频 → StreamAnalyzer（onset 检测 + 频率/衰减提取）
// 实时线程内只做 DSP，不做 DOM/存储操作；结果通过端口消息发给主线程。

import { StreamAnalyzer } from '../dsp/analyzer.ts';
import type { WorkletInMessage, WorkletOutMessage } from '../dsp/types.ts';

class ForgeProcessor extends AudioWorkletProcessor {
  private readonly analyzer: StreamAnalyzer;
  private readonly mono = new Float32Array(128);

  constructor() {
    super();
    this.analyzer = new StreamAnalyzer(
      { sampleRate: sampleRate, spectralGateEnabled: true },
      {
        onOnset: (sample, time) => {
          const msg: WorkletOutMessage = { type: 'onset', sample, time };
          this.port.postMessage(msg);
        },
        onStrike: (features) => {
          const msg: WorkletOutMessage = { type: 'strike', features };
          this.port.postMessage(msg);
        },
        onIgnored: (_sample, time, reason) => {
          const msg: WorkletOutMessage = { type: 'ignored', time, reason };
          this.port.postMessage(msg);
        },
        onLevel: (rms) => {
          const msg: WorkletOutMessage = { type: 'level', rms };
          this.port.postMessage(msg);
        },
      },
    );

    this.port.onmessage = (event: MessageEvent<WorkletInMessage>) => {
      const msg = event.data;
      if (msg.type === 'setGate') {
        this.analyzer.setSpectralGate(msg.enabled);
      } else if (msg.type === 'reset') {
        // 复位通过重建内部状态实现成本较高，这里仅通知门控；完整复位由页面重新建节点完成
      }
    };

    const ready: WorkletOutMessage = { type: 'ready' };
    this.port.postMessage(ready);
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    // 多声道混音为单声道
    const channels = input.length;
    for (let i = 0; i < 128; i++) {
      let sum = 0;
      for (let ch = 0; ch < channels; ch++) sum += input[ch][i] ?? 0;
      this.mono[i] = channels > 1 ? sum / channels : sum;
    }
    this.analyzer.process(this.mono);
    return true;
  }
}

registerProcessor('forge-processor', ForgeProcessor);
