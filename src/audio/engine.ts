// 音频引擎：
//  - 麦克风模式：getUserMedia → AudioWorkletNode（实时线程跑 StreamAnalyzer）
//  - 演示模式：合成 PCM 通过 AudioBuffer 播放，同时用脚本节点把同样的块喂给主线程 StreamAnalyzer
// 两条路径产出的事件结构一致，UI 层无感知。
import { StreamAnalyzer } from '../dsp/analyzer.ts';
import {
  renderScenario,
  SAMPLE_RATE,
  type SynthScenario,
} from '../dsp/synth.ts';
import type { StrikeFeatures, WorkletInMessage, WorkletOutMessage } from '../dsp/types.ts';

export interface EngineEvents {
  onOnset?: (time: number) => void;
  onStrike?: (features: StrikeFeatures) => void;
  onIgnored?: (time: number, reason: string) => void;
  onLevel?: (rms: number) => void;
  onEnded?: () => void;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private mediaStream: MediaStream | null = null;
  private demoAnalyzer: StreamAnalyzer | null = null;
  private demoSource: AudioBufferSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private readonly events: EngineEvents;
  mode: 'idle' | 'mic' | 'demo' = 'idle';

  constructor(events: EngineEvents) {
    this.events = events;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ sampleRate: SAMPLE_RATE });
    }
    return this.ctx;
  }

  // ---------------- 麦克风模式 ----------------
  async startMic(gateEnabled: boolean): Promise<void> {
    this.stop();
    const ctx = this.ensureContext();
    await ctx.audioWorklet.addModule('./worklet/forge-worklet.js');
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const source = ctx.createMediaStreamSource(this.mediaStream);
    const node = new AudioWorkletNode(ctx, 'forge-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
    node.port.onmessage = (e: MessageEvent<WorkletOutMessage>) => this.handleWorkletMessage(e.data);
    const gateMsg: WorkletInMessage = { type: 'setGate', enabled: gateEnabled };
    node.port.postMessage(gateMsg);
    source.connect(node);
    this.workletNode = node;
    this.mode = 'mic';
  }

  private handleWorkletMessage(msg: WorkletOutMessage): void {
    switch (msg.type) {
      case 'onset':
        this.events.onOnset?.(msg.time);
        break;
      case 'strike':
        this.events.onStrike?.(msg.features);
        break;
      case 'ignored':
        this.events.onIgnored?.(msg.time, msg.reason);
        break;
      case 'level':
        this.events.onLevel?.(msg.rms);
        break;
      case 'ready':
        break;
    }
  }

  // ---------------- 演示模式 ----------------
  async startDemo(scenario: SynthScenario, gateEnabled: boolean): Promise<void> {
    this.stop();
    const ctx = this.ensureContext();
    const rendered = renderScenario(scenario);
    const buffer = ctx.createBuffer(1, rendered.pcm.length, rendered.sampleRate);
    buffer.copyToChannel(rendered.pcm, 0);

    this.demoAnalyzer = new StreamAnalyzer(
      { sampleRate: rendered.sampleRate, spectralGateEnabled: gateEnabled },
      {
        onOnset: (_s, t) => this.events.onOnset?.(t),
        onStrike: (f) => this.events.onStrike?.(f),
        onIgnored: (_s, t, r) => this.events.onIgnored?.(t, r),
        onLevel: (rms) => this.events.onLevel?.(rms),
      },
    );

    // ScriptProcessor 把播放中的同一批样本喂给分析器（块大小 1024，内部再按 128 切）
    const processor = ctx.createScriptProcessor(1024, 1, 1);
    let readPos = 0;
    processor.onaudioprocess = (event) => {
      const out = event.outputBuffer.getChannelData(0);
      const chunk = Math.min(out.length, rendered.pcm.length - readPos);
      for (let i = 0; i < chunk; i++) out[i] = rendered.pcm[readPos + i];
      for (let i = chunk; i < out.length; i++) out[i] = 0;
      // 按 128 样本量子喂入，与 Worklet 行为一致
      for (let i = 0; i < chunk; i += 128) {
        const end = Math.min(i + 128, chunk);
        this.demoAnalyzer?.process(rendered.pcm.subarray(readPos + i, readPos + end));
      }
      readPos += chunk;
      if (readPos >= rendered.pcm.length) {
        const leftover = this.demoAnalyzer?.flush() ?? [];
        for (const f of leftover) this.events.onStrike?.(f);
        this.events.onEnded?.();
      }
    };

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(processor);
    // ScriptProcessor 必须连到 destination 才会触发（静音输出不影响分析）
    processor.connect(ctx.destination);
    src.onended = () => {
      if (this.mode === 'demo') this.events.onEnded?.();
    };
    src.start();
    this.demoSource = src;
    this.processorNode = processor;
    this.mode = 'demo';
  }

  setGate(enabled: boolean): void {
    if (this.workletNode) {
      const msg: WorkletInMessage = { type: 'setGate', enabled };
      this.workletNode.port.postMessage(msg);
    }
    if (this.demoAnalyzer) this.demoAnalyzer.setSpectralGate(enabled);
  }

  stop(): void {
    try {
      this.demoSource?.stop();
    } catch {
      /* 未开始或已停止 */
    }
    this.demoSource?.disconnect();
    this.processorNode?.disconnect();
    this.workletNode?.disconnect();
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.demoSource = null;
    this.processorNode = null;
    this.workletNode = null;
    this.mediaStream = null;
    this.demoAnalyzer = null;
    this.mode = 'idle';
  }

  async close(): Promise<void> {
    this.stop();
    await this.ctx?.close();
    this.ctx = null;
  }
}
