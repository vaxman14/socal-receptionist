// App shell: navy sidebar + mobile nav strip, shared by client + owner apps.

import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AccessibilityWidget from './AccessibilityWidget';

export function AppShell({ scope, links, adminLinks, children }) {
  const { user, signOut } = useAuth();

  return (
    <div className="app-shell">
      <AccessibilityWidget />
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img src="/logo-icon.svg" alt="" />
          <span className="name">
            SoCal Receptionist
            <small>{scope === 'owner' ? 'Platform Admin' : 'Business Console'}</small>
          </span>
        </div>
        <div className="sidebar-scope">{scope === 'owner' ? 'Owner' : 'Client'}</div>
        <nav className="sidebar-nav">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end}>
              {l.label}
            </NavLink>
          ))}
          {adminLinks && adminLinks.length > 0 && (
            <>
              <div className="sidebar-group-label">Admin</div>
              {adminLinks.map((l) => (
                <NavLink key={l.to} to={l.to} end={l.end}>
                  {l.label}
                </NavLink>
              ))}
            </>
          )}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <span className="topbar-user">{user?.email}</span>
          <button className="btn btn-secondary btn-sm" onClick={signOut}>
            Sign out
          </button>
        </header>
        <nav className="mobile-nav">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end}>
              {l.label}
            </NavLink>
          ))}
          {adminLinks &&
            adminLinks.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.end}>
                {l.label}
              </NavLink>
            ))}
        </nav>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
