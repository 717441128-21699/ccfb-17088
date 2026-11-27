// 锻打声学分析的共享类型定义（AudioWorklet 与主线程、Node 测试共用）

export type SteelGrade = '1045' | '1095' | 'T10' | 'W2';
export type BilletSize = 'small' | 'medium' | 'large';

export const STEEL_GRADES: { id: SteelGrade; label: string }[] = [
  { id: '1045', label: '45号钢 (1045)' },
  { id: '1095', label: '1095 高碳钢' },
  { id: 'T10', label: 'T10 工具钢' },
  { id: 'W2', label: 'W2 水淬钢' },
];

export const BILLET_SIZES: { id: BilletSize; label: string }[] = [
  { id: 'small', label: '小坯 (薄/短件)' },
  { id: 'medium', label: '中坯 (常规刀坯)' },
  { id: 'large', label: '大坯 (厚/长件)' },
];

/** 单个振动模态（基频或泛音）的提取结果 */
export interface ModeFeatures {
  /** 模态中心频率 Hz */
  frequency: number;
  /** 起始处线性振幅 */
  amplitude: number;
  /** 振幅 1/e 衰减时间常数（秒） */
  tau: number;
  /** 频率分裂时的第二峰 */
  splitPeak?: {
    frequency: number;
    amplitude: number;
    tau: number;
    /** 两峰间距 Hz */
    separation: number;
  };
}

/** 一锤的完整声学特征 */
export interface StrikeFeatures {
  /** 相对音频流起点的采样序号 */
  onsetSample: number;
  /** 相对音频流起点的秒数 */
  onsetTime: number;
  /** 锤击瞬间峰值 RMS */
  rmsPeak: number;
  /** 提取到的模态（第 0 个为坯料基频 f1） */
  modes: ModeFeatures[];
  /** 坯料基频 Hz（无有效结果时为 0） */
  f1: number;
  /** 基频衰减时间常数 s（无有效结果时为 0） */
  tau1: number;
  /** 暗裂综合评分 0~1 */
  crackScore: number;
  /** 是否判定为疑似暗裂 */
  crackSuspected: boolean;
  /** 衰减包络是否不规则 */
  irregularDecay: boolean;
  /** 是否检出频率分裂 */
  splitDetected: boolean;
  /** 对数包络拟合归一化残差 */
  fitResidual: number;
  /** 时域拍频强度 0~1（裂纹双峰产生的包络周期起伏） */
  beatStrength: number;
}

/** 标定单点：测温枪读数 + 当时锤声的 f1 / tau1 */
export interface CalibrationPoint {
  temperatureC: number;
  f1: number;
  tau1: number;
}

/** 某种钢材 + 某种坯料尺寸的一条标定曲线 */
export interface CalibrationProfile {
  id: string;
  grade: SteelGrade;
  size: BilletSize;
  points: CalibrationPoint[];
  createdAt: number;
  updatedAt: number;
}

/** 主线程保存的锤击记录 */
export interface StrikeRecord {
  id: number;
  onsetTime: number;
  wallClock: number;
  f1: number;
  tau1: number;
  rmsPeak: number;
  crackScore: number;
  crackSuspected: boolean;
  splitDetected: boolean;
  irregularDecay: boolean;
  temperatureC: number | null;
  remainingStrikes: number | null;
  ignored: boolean;
  ignoreReason?: string;
}

/** Worklet → 主线程消息 */
export type WorkletOutMessage =
  | { type: 'onset'; time: number; sample: number }
  | { type: 'strike'; features: StrikeFeatures }
  | { type: 'ignored'; time: number; reason: string }
  | { type: 'level'; rms: number }
  | { type: 'ready' };

/** 主线程 → Worklet 消息 */
export type WorkletInMessage =
  | { type: 'setGate'; enabled: boolean }
  | { type: 'reset' };
