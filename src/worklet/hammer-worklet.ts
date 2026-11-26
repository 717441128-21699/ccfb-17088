import { HammerAnalyzer } from '../core/analyzer';

declare function registerProcessor(name: string, processorCtor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

interface WorkletMessage {
  type: 'threshold' | 'reset' | 'configure';
  thresholdDb?: number;
}

class HammerEarProcessor extends AudioWorkletProcessor {
  private analyzer: HammerAnalyzer;
  private readonly scopeSampleRate: number;

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    const scope = globalThis as unknown as { sampleRate?: number };
    this.scopeSampleRate = scope.sampleRate ?? 48_000;
    const thresholdDb =
      (options?.processorOptions as { thresholdDb?: number } | undefined)?.thresholdDb ?? -34;
    this.analyzer = new HammerAnalyzer({
      sampleRate: this.scopeSampleRate,
      thresholdDb,
    });

    this.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
      const data = event.data;
      if (data.type === 'threshold' && typeof data.thresholdDb === 'number') {
        this.analyzer.thresholdDb = data.thresholdDb;
      }
      if (data.type === 'reset') this.analyzer.reset();
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const channel = input && input.length > 0 ? input[0] : undefined;

    // Keep the node connected while guaranteeing a silent output.
    for (const outputChannels of outputs) {
      for (const channelData of outputChannels) channelData.fill(0);
    }

    if (channel && channel.length > 0) {
      const strikes = this.analyzer.process(channel);
      for (const strike of strikes) {
        this.port.postMessage({
          type: 'strike',
          strike,
          workletSampleRate: this.scopeSampleRate,
        });
      }
    }
    return true;
  }
}

registerProcessor('hammer-ear-processor', HammerEarProcessor);
