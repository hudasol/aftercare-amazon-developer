import { useEffect, useState } from 'react';
import { Mark } from './components/common';
import { api } from './lib/api';
import { onWakeState, wakeState, type WakeState } from './lib/wake';
import { navigate, useRoute } from './lib/router';
import type { Session } from './lib/types';
import { AssistantView } from './views/AssistantView';
import { LabView } from './views/LabView';

export function App() {
  const route = useRoute();
  const [session, setSession] = useState<Session | null>(null);
  const [offline, setOffline] = useState(false);
  const [wake, setWake] = useState<WakeState>(wakeState());

  useEffect(() => onWakeState(setWake), []);

  useEffect(() => {
    api
      .session()
      .then(setSession)
      .catch(() => setOffline(true));
  }, []);

  useEffect(() => {
    document.title = route.view === 'lab' ? 'Resolution Lab · AFTERCARE' : 'AFTERCARE';
  }, [route.view]);

  const link = (target: 'assistant' | 'lab', label: string) => (
    <a
      href={target === 'lab' ? '/lab' : '/'}
      aria-current={route.view === target ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault();
        navigate({ view: target, caseId: route.caseId });
      }}
    >
      {label}
    </a>
  );

  return (
    <div className="shell">
      <a className="visually-hidden" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate({ view: 'assistant', caseId: null });
          }}
        >
          <Mark />
          AFTERCARE
        </a>
        <span className="sim-note">
          Simulated Alexa+-style assistant. Not an Amazon product. Fictional data.
        </span>
        <nav className="nav" aria-label="Main">
          {link('assistant', 'Assistant')}
          {link('lab', 'Resolution Lab')}
        </nav>
      </header>
      {wake === 'waking' && (
        <p className="notice" role="status" style={{ margin: 16 }}>
          Waking the demo, this can take about a minute. The free hosting plan pauses the server
          when nobody is using it. This page continues on its own once the server answers.
        </p>
      )}
      {offline && (
        <p className="notice" role="alert" style={{ margin: 16 }}>
          The AFTERCARE server isn’t reachable. Start it with <code>npm start</code>, then reload
          this page.
        </p>
      )}
      {route.view === 'lab' ? (
        <LabView caseId={route.caseId} session={session} />
      ) : (
        <AssistantView caseId={route.caseId} session={session} />
      )}
      <footer className="site-foot">
        <span>Fictional retailer and data. Not affiliated with or endorsed by Amazon.</span>
        <span className="site-foot-links">
          <a href="https://github.com/hudasol/aftercare-amazon-developer">Source</a>
          <a href="https://github.com/hudasol/aftercare-amazon-developer/blob/main/LICENSE">
            Apache 2.0
          </a>
        </span>
      </footer>
    </div>
  );
}
