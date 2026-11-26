import type { DetectedStrike } from '../core/analyzer';

export interface WorkletStrikeMessage {
  type: 'strike';
  strike: DetectedStrike;
  workletSampleRate: number;
  workletTime?: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private inputGain: GainNode | null = null;
  private node: AudioWorkletNode | null = null;
  analyser: AnalyserNode | null = null;
  running = false;
  onStrike: ((strike: DetectedStrike, receivedAudioTime: number) => void) | null = null;
  onError: ((error: Error) => void) | null = null;

  async start(deviceId: string | undefined, thresholdDb: number): Promise<void> {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持麦克风采集，请使用最新版 Chrome/Edge。');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    await this.ctx.resume();

    const workletUrl = new URL('worklets/hammer-worklet.js', document.baseURI).toString();
    await this.ctx.audioWorklet.addModule(workletUrl);

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.inputGain = this.ctx.createGain();
    this.inputGain.gain.value = 1;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.55;

    this.node = new AudioWorkletNode(this.ctx, 'hammer-ear-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { thresholdDb },
    });

    this.node.port.onmessage = (event: MessageEvent<WorkletStrikeMessage>) => {
      if (event.data?.type === 'strike' && this.ctx) {
        this.onStrike?.(event.data.strike, this.ctx.currentTime);
      }
    };
    this.node.port.onmessageerror = (event) => {
      console.error('AudioWorklet 消息错误', event);
    };

    this.source.connect(this.inputGain);
    this.inputGain.connect(this.analyser);
    this.inputGain.connect(this.node);
    // Processor writes silence to outputs. Connecting keeps the node alive.
    this.node.connect(this.ctx.destination);
    this.running = true;
  }

  setGain(gain: number): void {
    if (this.inputGain && this.ctx) {
      this.inputGain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.015);
    }
  }

  setThreshold(thresholdDb: number): void {
    this.node?.port.postMessage({ type: 'threshold', thresholdDb });
  }

  resetDetector(): void {
    this.node?.port.postMessage({ type: 'reset' });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();
    this.inputGain?.disconnect();
    this.analyser?.disconnect();
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close();
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.inputGain = null;
    this.analyser = null;
  }

  static async listDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }
}
