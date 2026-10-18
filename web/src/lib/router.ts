import { useEffect, useState } from 'react';

export type Route =
  { view: 'assistant'; caseId: string | null } | { view: 'lab'; caseId: string | null };

export function parse(pathname: string): Route {
  const lab = pathname.match(/^\/lab(?:\/([\w-]+))?\/?$/);
  if (lab) return { view: 'lab', caseId: lab[1] ?? null };
  const c = pathname.match(/^\/cases\/([\w-]+)\/?$/);
  return { view: 'assistant', caseId: c?.[1] ?? null };
}

export function href(route: Route): string {
  if (route.view === 'lab') return route.caseId ? `/lab/${route.caseId}` : '/lab';
  return route.caseId ? `/cases/${route.caseId}` : '/';
}

export function navigate(route: Route, replace = false): void {
  const url = href(route);
  if (url === window.location.pathname) return;
  if (replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.pathname));
  useEffect(() => {
    const update = () => setRoute(parse(window.location.pathname));
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return route;
}
