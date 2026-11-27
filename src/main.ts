// 应用入口：顶部钢材/坯料选择 + 四个页面的 hash 路由。
import './ui/styles.css';
import { BILLET_SIZES, STEEL_GRADES } from './dsp/types.ts';
import { store } from './state/store.ts';
import { el } from './ui/dom.ts';
import { currentRoute, navigate, onRouteChange, type Route } from './ui/router.ts';
import { renderCalibrationPage } from './ui/pages/calibration.ts';
import { renderLivePage } from './ui/pages/live.ts';
import { renderRecordsPage } from './ui/pages/records.ts';
import { renderTemperaturePage } from './ui/pages/temperature.ts';

const TABS: { route: Route; label: string }[] = [
  { route: 'live', label: '实时监听' },
  { route: 'records', label: '锤击记录' },
  { route: 'temperature', label: '温度曲线' },
  { route: 'calibration', label: '标定管理' },
];

function render(): void {
  const root = document.querySelector<HTMLDivElement>('#app');
  if (!root) return;
  const route = currentRoute();
  const state = store.getState();

  const gradeSel = el('select', {}, ...STEEL_GRADES.map((g) =>
    el('option', { value: g.id }, g.label))) as HTMLSelectElement;
  gradeSel.value = state.grade;
  gradeSel.addEventListener('change', () => store.setGrade(gradeSel.value as typeof state.grade));

  const sizeSel = el('select', {}, ...BILLET_SIZES.map((g) =>
    el('option', { value: g.id }, g.label))) as HTMLSelectElement;
  sizeSel.value = state.size;
  sizeSel.addEventListener('change', () => store.setSize(sizeSel.value as typeof state.size));

  const tabs = el('nav', { className: 'tabs' }, ...TABS.map((t) => {
    const btn = el('button', {
      className: `tab${t.route === route ? ' active' : ''}`,
    }, t.label);
    btn.addEventListener('click', () => navigate(t.route));
    return btn;
  }));

  const page = el('main', { id: 'page' });
  const header = el('header', { className: 'app-header' },
    el('div', { className: 'brand' },
      el('span', { className: 'anvil' }, '⚒'),
      el('div', {},
        el('h1', {}, '砧边声学助手'),
        el('div', { className: 'sub' }, '听锤声 · 估温度 · 察暗裂'))),
    el('div', { className: 'steel-selectors' },
      el('label', {}, '钢材 ', gradeSel),
      el('label', {}, '坯料 ', sizeSel)),
  );

  root.replaceChildren(el('div', { className: 'app' }, header, tabs, page));

  switch (route) {
    case 'live':
      renderLivePage(page);
      break;
    case 'records':
      renderRecordsPage(page);
      break;
    case 'temperature':
      renderTemperaturePage(page);
      break;
    case 'calibration':
      renderCalibrationPage(page);
      break;
  }
}

render();
onRouteChange(() => render());
