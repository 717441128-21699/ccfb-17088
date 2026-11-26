export type DomChild = Node | string | number | false | null | undefined;

export interface DomProps {
  class?: string;
  id?: string;
  title?: string;
  text?: string;
  html?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  style?: Partial<CSSStyleDeclaration> | Record<string, string>;
  dataset?: Record<string, string>;
  on?: Record<string, EventListenerOrEventListenerObject>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: DomProps | null,
  ...children: DomChild[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props?.class) el.className = props.class;
  if (props?.id) el.id = props.id;
  if (props?.title) el.title = props.title;
  if (props?.text !== undefined) el.textContent = props.text;
  if (props?.html !== undefined) el.innerHTML = props.html;
  if (props?.attrs) {
    for (const [k, v] of Object.entries(props.attrs)) {
      if (v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (props?.style) Object.assign(el.style, props.style);
  if (props?.dataset) Object.assign(el.dataset, props.dataset);
  if (props?.on) {
    for (const [event, handler] of Object.entries(props.on)) {
      el.addEventListener(event, handler);
    }
  }
  appendChildren(el, children);
  return el;
}

export function appendChildren(el: HTMLElement, children: DomChild[]): void {
  for (const child of children.flat()) {
    if (child === false || child === null || child === undefined) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

export function fmtTemp(v?: number): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}°C` : '—';
}

export function fmtMs(v?: number): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(0)} ms` : '—';
}

export function fmtHz(v?: number): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)} Hz` : '—';
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function downloadText(filename: string, text: string, type = 'text/plain'): void {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
