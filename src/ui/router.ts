// 极简 hash 路由：#/live、#/records、#/temperature、#/calibration
export type Route = 'live' | 'records' | 'temperature' | 'calibration';

const ROUTES: Route[] = ['live', 'records', 'temperature', 'calibration'];

export function currentRoute(): Route {
  const hash = window.location.hash.replace('#/', '').replace('#', '') as Route;
  return ROUTES.includes(hash) ? hash : 'live';
}

export function navigate(route: Route): void {
  window.location.hash = `/${route}`;
}

export function onRouteChange(fn: (route: Route) => void): () => void {
  const handler = (): void => fn(currentRoute());
  window.addEventListener('hashchange', handler);
  return () => window.removeEventListener('hashchange', handler);
}
