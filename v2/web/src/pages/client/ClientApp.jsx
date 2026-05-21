// Client dashboard shell + nested routes.

import { Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from '../../components/Sidebar';
import Overview from './Overview';
import Leads from './Leads';
import Conversations from './Conversations';
import Calls from './Calls';
import Settings from './Settings';
import Billing from './Billing';

const LINKS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/leads', label: 'Leads' },
  { to: '/conversations', label: 'Conversations' },
  { to: '/calls', label: 'Calls' },
  { to: '/settings', label: 'Settings' },
  { to: '/billing', label: 'Billing' },
];

export default function ClientApp() {
  return (
    <AppShell scope="client" links={LINKS}>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="leads" element={<Leads />} />
        <Route path="conversations" element={<Conversations />} />
        <Route path="calls" element={<Calls />} />
        <Route path="settings" element={<Settings />} />
        <Route path="billing" element={<Billing />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
