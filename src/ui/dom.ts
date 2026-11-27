// 通用小工具
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function tempClass(tempC: number | null): string {
  if (tempC == null) return 'muted';
  if (tempC >= 1000) return 'temp-hot';
  if (tempC >= 850) return 'temp-warm';
  return 'temp-cool';
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

let toastTimer: number | undefined;
export function toast(message: string): void {
  document.querySelectorAll('.toast').forEach((n) => n.remove());
  const node = el('div', { className: 'toast' }, message);
  document.body.append(node);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.remove(), 2600);
}
