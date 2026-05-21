// App shell: navy sidebar + mobile nav strip, shared by client + owner apps.

import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function AppShell({ scope, links, children }) {
  const { user, signOut } = useAuth();

  return (
    <div className="app-shell">
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
        </nav>
        <div className="sidebar-foot">
          <div className="email">{user?.email}</div>
          <button className="btn btn-secondary btn-sm btn-block" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <span className="name">SoCal Receptionist</span>
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
        </nav>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
