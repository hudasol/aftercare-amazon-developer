import { useEffect, useState } from 'react';
import { Mark } from './components/common';
import { api } from './lib/api';
import { navigate, useRoute } from './lib/router';
import type { Session } from './lib/types';
import { AssistantView } from './views/AssistantView';
import { LabView } from './views/LabView';

export function App() {
  const route = useRoute();
  const [session, setSession] = useState<Session | null>(null);
  const [offline, setOffline] = useState(false);

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
        <span
          className="sim-note"
          title="Hackathon demo. Not an Amazon product and not connected to Alexa."
        >
          Simulated Alexa+-style assistant surface, fictional data
        </span>
        <nav className="nav" aria-label="Main">
          {link('assistant', 'Assistant')}
          {link('lab', 'Resolution Lab')}
        </nav>
      </header>
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
    </div>
  );
}
