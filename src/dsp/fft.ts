// 无依赖的 radix-2 迭代 FFT，以及常用窗函数 / 峰值插值。
// 全部使用可复用的预分配数组，避免实时线程里产生 GC 压力。

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** 原地迭代 FFT（基 2）。re/im 长度必须相等且为 2 的幂。inverse=true 时做 IFFT。 */
export function fft(re: Float32Array, im: Float32Array, inverse = false): void {
  const n = re.length;
  if (!isPowerOfTwo(n)) throw new Error(`FFT 长度必须是 2 的幂，收到 ${n}`);

  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (sign * 2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = i + k + half;
        const tRe = curRe * re[b] - curIm * im[b];
        const tIm = curRe * im[b] + curIm * re[b];
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** Hann 窗（周期型） */
export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  }
  return w;
}

export interface SpectralPeak {
  bin: number;
  frequency: number;
  magnitude: number;
}

/**
 * 抛物线插值，把 bin 级峰值细化到亚 bin 精度。
 * 返回修正后的频率与幅值。
 */
export function parabolicInterpolation(
  mag: Float32Array,
  bin: number,
  binHz: number,
): { frequency: number; magnitude: number } {
  const m0 = mag[bin - 1] ?? 0;
  const m1 = mag[bin];
  const m2 = mag[bin + 1] ?? 0;
  const denom = m0 - 2 * m1 + m2;
  const shift = denom === 0 ? 0 : 0.5 * (m0 - m2) / denom;
  const refinedMag = m1 - 0.25 * (m0 - m2) * shift;
  return {
    frequency: (bin + shift) * binHz,
    magnitude: Math.max(0, refinedMag),
  };
}

/**
 * Goertzel：单频幅度测量，比整段 FFT 便宜，适合逐子帧测模态包络。
 * 返回该频率在给定片段上的线性幅度（已按片段长度归一）。
 */
export function goertzelMagnitude(x: Float32Array, frequency: number, sampleRate: number): number {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  // |X(k)| ≈ sqrt(s1² + s2² - coeff·s1·s2)
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.sqrt(Math.max(0, power)) / x.length;
}
