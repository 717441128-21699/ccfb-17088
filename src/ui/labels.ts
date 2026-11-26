import type { StrikeVerdict } from '../core/types';

export const VERDICT_META: Record<
  StrikeVerdict,
  { label: string; short: string; color: string; advice: string }
> = {
  good: {
    label: '温度合适 · 继续锻打',
    short: '可打',
    color: '#f59e0b',
    advice: '声音低沉、衰减快，坯料仍在合适锻造温度。',
  },
  cooling: {
    label: '温度偏低 · 准备回炉',
    short: '少打',
    color: '#fb923c',
    advice: '频率已明显升高，最后轻锤整理后应回炉。',
  },
  cold: {
    label: '已经过冷 · 立即停锤回炉',
    short: '停锤',
    color: '#ef4444',
    advice: '再打可能产生暗裂或使裂纹扩展。',
  },
  crack: {
    label: '疑似暗裂 · 停锤检查',
    short: '裂?',
    color: '#dc2626',
    advice: '模态频率分裂且衰减不规则，请检查断面、喷砂或探伤。',
  },
  rejected: {
    label: '排除非砧边目标声',
    short: '排除',
    color: '#64748b',
    advice: '频谱与当前钢材/尺寸标定不匹配，可能是他人锤声或噪声。',
  },
};

export function profileLabel(key: string, steels: { id: string; name: string }[], sizes: { id: string; label: string }[]): string {
  const [steelId, sizeId] = key.split('::');
  const steel = steels.find((s) => s.id === steelId)?.name ?? steelId;
  const size = sizes.find((s) => s.id === sizeId)?.label ?? sizeId;
  return `${steel} · ${size}`;
}
