import { defaultData } from '../core/defaults';
import type { AppData, CalibrationPoint, StrikeRecord } from '../core/types';

const STORAGE_KEY = 'smith-ear-data-v1';

type Listener = (data: AppData) => void;

function migrate(raw: unknown): AppData {
  const base = defaultData();
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Partial<AppData>;
  return {
    ...base,
    ...value,
    version: 1,
    settings: { ...base.settings, ...(value.settings ?? {}) },
    steels: value.steels?.length ? value.steels : base.steels,
    sizes: value.sizes?.length ? value.sizes : base.sizes,
    calibration: value.calibration ?? base.calibration,
    strikes: value.strikes ?? [],
  };
}

export function loadData(): AppData {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return defaultData();
    return migrate(JSON.parse(text));
  } catch (error) {
    console.warn('读取本地数据失败，已使用默认数据', error);
    return defaultData();
  }
}

class Store {
  data: AppData;
  private listeners = new Set<Listener>();

  constructor() {
    this.data = loadData();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(mutator: (draft: AppData) => void): void {
    mutator(this.data);
    this.persist();
    for (const listener of this.listeners) listener(this.data);
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (error) {
      console.warn('保存本地数据失败', error);
    }
  }

  updateSettings(patch: Partial<AppData['settings']>): void {
    this.commit((d) => {
      d.settings = { ...d.settings, ...patch };
    });
  }

  addStrike(strike: StrikeRecord): void {
    this.commit((d) => {
      d.strikes = [strike, ...d.strikes].slice(0, 800);
    });
  }

  updateStrike(id: string, patch: Partial<StrikeRecord>): void {
    this.commit((d) => {
      const idx = d.strikes.findIndex((s) => s.id === id);
      if (idx >= 0) d.strikes[idx] = { ...d.strikes[idx], ...patch };
    });
  }

  deleteStrike(id: string): void {
    this.commit((d) => {
      d.strikes = d.strikes.filter((s) => s.id !== id);
    });
  }

  clearStrikes(): void {
    this.commit((d) => {
      d.strikes = [];
    });
  }

  addCalibrationPoint(point: CalibrationPoint): void {
    this.commit((d) => {
      d.calibration = [point, ...d.calibration];
    });
  }

  deleteCalibrationPoint(id: string): void {
    this.commit((d) => {
      d.calibration = d.calibration.filter((p) => p.id !== id);
    });
  }

  resetAll(): void {
    this.data = defaultData();
    this.persist();
    for (const listener of this.listeners) listener(this.data);
  }

  replaceData(data: AppData): void {
    this.data = migrate(data);
    this.persist();
    for (const listener of this.listeners) listener(this.data);
  }
}

export const store = new Store();
