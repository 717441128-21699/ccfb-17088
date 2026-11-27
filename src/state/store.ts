// 全局应用状态：当前钢材/坯料选择、标定曲线、锤击记录。
// 简单的发布订阅 store，页面订阅变化后自行重渲染。
import { estimateRemainingStrikes, estimateTemperature } from '../dsp/temperature.ts';
import type {
  BilletSize,
  CalibrationProfile,
  SteelGrade,
  StrikeFeatures,
  StrikeRecord,
} from '../dsp/types.ts';
import { loadProfiles, loadRecords, saveProfiles, saveRecords } from './storage.ts';

export interface AppState {
  grade: SteelGrade;
  size: BilletSize;
  gateEnabled: boolean;
  monitoring: boolean;
  source: 'mic' | 'demo' | 'idle';
  profiles: CalibrationProfile[];
  records: StrikeRecord[];
  /** 最近一次电平 RMS，供实时页表头动画 */
  levelRms: number;
}

type Listener = (state: AppState) => void;

const initial: AppState = {
  grade: '1045',
  size: 'medium',
  gateEnabled: true,
  monitoring: false,
  source: 'idle',
  profiles: loadProfiles(),
  records: loadRecords(),
  levelRms: 0,
};

class AppStore {
  private state: AppState = initial;
  private readonly listeners = new Set<Listener>();
  private nextId = 1;

  getState(): AppState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  setGrade(grade: SteelGrade): void {
    this.state = { ...this.state, grade };
    this.emit();
  }

  setSize(size: BilletSize): void {
    this.state = { ...this.state, size };
    this.emit();
  }

  setGate(enabled: boolean): void {
    this.state = { ...this.state, gateEnabled: enabled };
    this.emit();
  }

  setMonitoring(monitoring: boolean, source: AppState['source']): void {
    this.state = { ...this.state, monitoring, source };
    this.emit();
  }

  setLevel(rms: number): void {
    this.state = { ...this.state, levelRms: rms };
    // 电平更新频繁，仅通知监听者但不持久化
    this.emit();
  }

  activeProfile(): CalibrationProfile | null {
    const { grade, size, profiles } = this.state;
    return profiles.find((p) => p.grade === grade && p.size === size) ?? null;
  }

  /** 一条完整锤击特征入库：补算温度与剩余锤数 */
  addStrike(features: StrikeFeatures, ignored = false, ignoreReason?: string): StrikeRecord {
    const profile = this.activeProfile();
    const temp = estimateTemperature(features.f1, features.tau1, profile);
    const recent = this.state.records
      .filter((r) => !r.ignored)
      .slice(-8)
      .map((r) => ({ temperatureC: r.temperatureC, onsetTime: r.onsetTime }));
    const remaining = estimateRemainingStrikes(
      temp.source === 'none' ? null : temp.temperatureC,
      recent,
    );
    const record: StrikeRecord = {
      id: this.nextId++,
      onsetTime: features.onsetTime,
      wallClock: Date.now(),
      f1: features.f1,
      tau1: features.tau1,
      rmsPeak: features.rmsPeak,
      crackScore: features.crackScore,
      crackSuspected: features.crackSuspected,
      splitDetected: features.splitDetected,
      irregularDecay: features.irregularDecay,
      temperatureC: temp.source === 'none' ? null : temp.temperatureC,
      remainingStrikes: remaining,
      ignored,
      ignoreReason,
    };
    this.state = { ...this.state, records: [...this.state.records, record] };
    saveRecords(this.state.records);
    this.emit();
    return record;
  }

  addIgnored(time: number, reason: string): void {
    const record: StrikeRecord = {
      id: this.nextId++,
      onsetTime: time,
      wallClock: Date.now(),
      f1: 0,
      tau1: 0,
      rmsPeak: 0,
      crackScore: 0,
      crackSuspected: false,
      splitDetected: false,
      irregularDecay: false,
      temperatureC: null,
      remainingStrikes: null,
      ignored: true,
      ignoreReason: reason,
    };
    this.state = { ...this.state, records: [...this.state.records, record] };
    saveRecords(this.state.records);
    this.emit();
  }

  upsertProfile(profile: CalibrationProfile): void {
    const others = this.state.profiles.filter(
      (p) => !(p.grade === profile.grade && p.size === profile.size),
    );
    this.state = { ...this.state, profiles: [...others, profile] };
    saveProfiles(this.state.profiles);
    this.emit();
  }

  deleteProfile(id: string): void {
    this.state = {
      ...this.state,
      profiles: this.state.profiles.filter((p) => p.id !== id),
    };
    saveProfiles(this.state.profiles);
    this.emit();
  }

  clearRecords(): void {
    this.state = { ...this.state, records: [] };
    saveRecords([]);
    this.emit();
  }
}

export const store = new AppStore();
