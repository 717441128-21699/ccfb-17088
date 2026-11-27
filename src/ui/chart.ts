// 零依赖 Canvas 折线图：支持多序列、温度参考线、DPR 适配、悬停提示。
export interface ChartSeries {
  label: string;
  color: string;
  points: { x: number; y: number }[];
  dashed?: boolean;
}

export interface ChartOptions {
  yLabel?: string;
  xLabel?: string;
  /** y 轴参考线（如回炉温度） */
  referenceLines?: { y: number; color: string; label?: string }[];
  /** y 轴固定范围，缺省自适应 */
  yRange?: [number, number];
  height?: number;
}

export function drawChart(
  canvas: HTMLCanvasElement,
  series: ChartSeries[],
  opts: ChartOptions = {},
): void {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 600;
  const cssHeight = opts.height ?? 240;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const padL = 52;
  const padR = 14;
  const padT = 16;
  const padB = 34;
  const w = cssWidth - padL - padR;
  const h = cssHeight - padT - padB;

  ctx.clearRect(0, 0, cssWidth, cssHeight);
  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length === 0) {
    ctx.fillStyle = '#9a8d78';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无数据', cssWidth / 2, cssHeight / 2);
    return;
  }

  const xs = allPoints.map((p) => p.x);
  const ys = allPoints.map((p) => p.y);
  let xMin = Math.min(...xs);
  let xMax = Math.max(...xs);
  if (xMax - xMin < 1e-6) xMax = xMin + 1;
  let yMin: number;
  let yMax: number;
  if (opts.yRange) {
    [yMin, yMax] = opts.yRange;
  } else {
    yMin = Math.min(...ys);
    yMax = Math.max(...ys);
    const refYs = (opts.referenceLines ?? []).map((r) => r.y);
    if (refYs.length) {
      yMin = Math.min(yMin, ...refYs);
      yMax = Math.max(yMax, ...refYs);
    }
    const pad = (yMax - yMin) * 0.12 || 1;
    yMin -= pad;
    yMax += pad;
  }

  const sx = (x: number) => padL + ((x - xMin) / (xMax - xMin)) * w;
  const sy = (y: number) => padT + (1 - (y - yMin) / (yMax - yMin)) * h;

  // 网格 + y 轴刻度
  ctx.strokeStyle = '#3a3126';
  ctx.fillStyle = '#9a8d78';
  ctx.font = '11px sans-serif';
  ctx.lineWidth = 1;
  const ticks = 5;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= ticks; i++) {
    const y = yMin + ((yMax - yMin) * i) / ticks;
    const py = sy(y);
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(padL + w, py);
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(Math.round(y).toString(), padL - 6, py);
  }

  // 参考线
  for (const ref of opts.referenceLines ?? []) {
    const py = sy(ref.y);
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = ref.color;
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(padL + w, py);
    ctx.stroke();
    ctx.restore();
    if (ref.label) {
      ctx.textAlign = 'left';
      ctx.fillStyle = ref.color;
      ctx.fillText(ref.label, padL + 4, py - 7);
    }
  }

  // 数据线
  for (const s of series) {
    if (s.points.length === 0) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.setLineDash(s.dashed ? [5, 4] : []);
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const px = sx(p.x);
      const py = sy(p.y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    // 数据点
    ctx.fillStyle = s.color;
    for (const p of s.points) {
      ctx.beginPath();
      ctx.arc(sx(p.x), sy(p.y), 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 轴标签
  ctx.fillStyle = '#9a8d78';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  if (opts.xLabel) ctx.fillText(opts.xLabel, padL + w / 2, cssHeight - 12);
  ctx.save();
  ctx.translate(14, padT + h / 2);
  ctx.rotate(-Math.PI / 2);
  if (opts.yLabel) ctx.fillText(opts.yLabel, 0, 0);
  ctx.restore();

  // 图例
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let lx = padL;
  for (const s of series) {
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, 6, 14, 3);
    ctx.fillStyle = '#ece4d6';
    ctx.fillText(s.label, lx + 18, 8);
    lx += ctx.measureText(s.label).width + 40;
  }
}
