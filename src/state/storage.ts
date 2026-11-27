// 本地持久化：标定曲线与锤击记录存 localStorage，键名带版本号便于后续迁移。
import type { CalibrationProfile, StrikeRecord } from '../dsp/types.ts';

const CAL_KEY = 'forge-ear.calibration.v1';
const RECORD_KEY = 'forge-ear.records.v1';
const MAX_RECORDS = 2000;

export function loadProfiles(): CalibrationProfile[] {
  try {
    const raw = localStorage.getItem(CAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CalibrationProfile[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveProfiles(profiles: CalibrationProfile[]): void {
  localStorage.setItem(CAL_KEY, JSON.stringify(profiles));
}

export function loadRecords(): StrikeRecord[] {
  try {
    const raw = localStorage.getItem(RECORD_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StrikeRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRecords(records: StrikeRecord[]): void {
  // 只保留最近 MAX_RECORDS 条，防止无限增长
  const trimmed = records.slice(-MAX_RECORDS);
  localStorage.setItem(RECORD_KEY, JSON.stringify(trimmed));
}

export function clearRecords(): void {
  localStorage.removeItem(RECORD_KEY);
}
