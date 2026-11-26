import './styles.css';
import { AudioEngine } from './audio/AudioEngine';
import { ANVIL_MODES_HZ } from './core/physics';
import { buildRecordFromDetected } from './core/pipeline';
import { store } from './state/store';
import type { PageId } from './core/types';
import { h } from './ui/dom';
import { renderCalibration } from './ui/pages/calibration';
import { renderMonitor } from './ui/pages/monitor';
import { renderStrikes } from './ui/pages/strikes';
import { renderTemperature } from './ui/pages/temperature';
import type { PageHandle } from './ui/pages/types';

const appRoot = document.querySelector<HTMLDivElement>('#app');
if (!appRoot) throw new Error('#app root is missing');
const app: HTMLDivElement = appRoot;

const engine = new AudioEngine();
let currentPage: PageId = 'monitor';
let pageCleanup: (() => void) | undefined;

engine.onStrike = (detected, audioTime) => {
  const settings = store.data.settings;
  const recentAscending = [...store.data.strikes]
    .filter((s) => s.profileKey === settings.profileKey)
    .reverse()
    .slice(-8);
  const record = buildRecordFromDetected(detected, {
    profileKey: settings.profileKey,
    steels: store.data.steels,
    sizes: store.data.sizes,
    calibration: store.data.calibration,
    recent: recentAscending,
    source: 'live',
    audioTime,
    transportLatencyMs: 4,
    interferenceHz: ANVIL_MODES_HZ,
  });
  store.addStrike(record);
};

engine.onError = (error) => console.error(error);

function render(): void {
  pageCleanup?.();
  pageCleanup = undefined;
  app.replaceChildren();

  const content = h('main', { class: 'page-content' });
  const nav = renderNav();
  const shell = h('div', { class: 'app-shell' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' },
        h('div', { class: 'brand-mark', html: anvilSvg }),
        h('div', null, h('h1', null, '铁匠之耳'), h('p', null, 'Smith Ear · 砧边听音台')),
      ),
      nav.desktop,
      h('div', { class: 'sidebar-foot' },
        h('span', { class: `status-dot ${engine.running ? 'live' : ''}` }),
        h('span', null, engine.running ? 'AudioWorklet 正在分析' : '监听未启动'),
      ),
    ),
    h('div', { class: 'main-column' },
      h('header', { class: 'topbar' },
        h('div', null, h('span', { class: 'eyebrow' }, pageEyebrow(currentPage)), h('h2', null, pageTitle(currentPage))),
        h('div', { class: 'topbar-right' },
          h('span', { class: `live-pill ${engine.running ? 'on' : ''}` }, engine.running ? '● LIVE' : 'OFFLINE'),
          h('span', { class: 'profile-pill' }, currentProfileName()),
        ),
      ),
      content,
    ),
    nav.mobile,
  );

  app.append(shell);

  let handle: PageHandle;
  if (currentPage === 'monitor') handle = renderMonitor({ engine, refresh: render });
  else if (currentPage === 'strikes') handle = renderStrikes();
  else if (currentPage === 'temperature') handle = renderTemperature();
  else handle = renderCalibration();

  content.append(handle.root);
  pageCleanup = handle.cleanup;
}

function renderNav(): { desktop: HTMLElement; mobile: HTMLElement } {
  const items: Array<{ id: PageId; label: string; icon: string }> = [
    { id: 'monitor', label: '实时监听', icon: '◉' },
    { id: 'strikes', label: '锤击记录', icon: '▤' },
    { id: 'temperature', label: '温度曲线', icon: '∿' },
    { id: 'calibration', label: '标定管理', icon: '⚙' },
  ];
  const buttons = items.map((item) =>
    h('button', {
      class: `nav-item ${currentPage === item.id ? 'active' : ''}`,
      on: { click: () => { currentPage = item.id; render(); } },
    }, h('span', { class: 'nav-icon' }, item.icon), h('span', null, item.label)),
  );
  return {
    desktop: h('nav', { class: 'nav-desktop' }, ...buttons),
    mobile: h('nav', { class: 'nav-mobile' }, ...items.map((item) =>
      h('button', {
        class: `nav-mobile-item ${currentPage === item.id ? 'active' : ''}`,
        on: { click: () => { currentPage = item.id; render(); } },
      }, h('span', { class: 'nav-icon' }, item.icon), h('span', null, item.label)),
    )),
  };
}

function currentProfileName(): string {
  const [steelId, sizeId] = store.data.settings.profileKey.split('::');
  const steel = store.data.steels.find((s) => s.id === steelId)?.name ?? steelId;
  const size = store.data.sizes.find((s) => s.id === sizeId)?.label ?? sizeId;
  return `${steel} · ${size}`;
}

function pageTitle(id: PageId): string {
  return { monitor: '实时监听', strikes: '锤击记录', temperature: '温度曲线', calibration: '标定管理' }[id];
}
function pageEyebrow(id: PageId): string {
  return {
    monitor: 'LOW LATENCY WORKLET',
    strikes: 'EVERY BLOW, SEPARATED',
    temperature: 'CALIBRATED THERMAL CURVE',
    calibration: 'IR GUN DATA & SYNTHETIC TEST',
  }[id];
}

const anvilSvg = `<svg viewBox="0 0 48 48" width="30" height="30" aria-hidden="true"><path fill="currentColor" d="M8 15h25c4 0 7-2 9-5 1 5-1 9-6 11l-6 2v6h5v4H13v-4h5v-7l-7-3c-2-1-3-2-3-4Zm10 13v1h12v-1l-6-2-6 2Z"/></svg>`;

store.subscribe(() => render());
window.addEventListener('smith-ear:refresh', render);
render();
