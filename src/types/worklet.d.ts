// AudioWorklet 全局环境的最小类型声明（标准 DOM lib 未覆盖 worklet 作用域）。

interface AudioWorkletProcessorOptions {
  numberOfInputs?: number;
  numberOfOutputs?: number;
  outputChannelCount?: number[];
  parameterData?: Record<string, number>;
  processorOptions?: unknown;
}

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletProcessorOptions);
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters?: Record<string, Float32Array>): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletProcessorOptions) => AudioWorkletProcessor,
): void;

// Worklet 全局注入的采样率
declare const sampleRate: number;
