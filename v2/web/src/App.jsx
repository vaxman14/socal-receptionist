// Root router — chooses the surface to render from the session + detected role.
//
//   no session             -> <Login/>
//   session, role 'owner'  -> <OwnerApp/>   (owns its own <Routes>)
//   session, role 'client' -> <ClientApp/>  (owns its own <Routes>)
//   session, 'onboarding'  -> <Wizard/>     (re-detects role on completion)

import { useAuth } from './context/AuthContext';
import { useRole } from './context/useRole';
import { Loading, ErrorState } from './components/States';
import Login from './pages/Login';
import OwnerApp from './pages/owner/OwnerApp';
import ClientApp from './pages/client/ClientApp';
import Wizard from './pages/onboarding/Wizard';

export default function App() {
  const { session, loading } = useAuth();

  if (loading) return <Loading label="Loading…" />;
  if (!session) return <Login />;

  // A session exists — role detection decides which app to mount.
  return <RoleRouter />;
}

// Split out so useRole only runs once we know there is a session.
function RoleRouter() {
  const { role, loading, error, reload } = useRole();

  if (loading) return <Loading label="Loading your account…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  if (role === 'owner') return <OwnerApp />;
  if (role === 'client') return <ClientApp />;
  if (role === 'onboarding') return <Wizard onComplete={reload} />;

  // Should not happen — role is always set once loading/error are clear.
  return <ErrorState message="Could not determine your account type." onRetry={reload} />;
}
