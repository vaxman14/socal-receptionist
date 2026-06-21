// Client dashboard shell + nested routes.

import { Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from '../../components/Sidebar';
import Overview from './Overview';
import Leads from './Leads';
import Chats from './Chats';
import Calls from './Calls';
import TimeTickets from './TimeTickets';
import OutboundLeads from './OutboundLeads';
import IntegrationSettings from './IntegrationSettings';
import Marketing from './Marketing';
import Reminders from './Reminders';
import Settings from './Settings';
import Billing from './Billing';
import Help from '../Help';
// Platform-admin pages — shown to super-admins in addition to their client app.
import PlatformOverview from '../owner/PlatformOverview';
import Tenants from '../owner/Tenants';
import TenantDetail from '../owner/TenantDetail';
import Documents from '../owner/Documents';
import AuditLog from '../owner/AuditLog';

const LINKS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/leads', label: 'Leads' },
  { to: '/chat', label: 'Live Chat' },
  { to: '/calls', label: 'Calls' },
  { to: '/integrations', label: 'Integrations' },
  { to: '/marketing', label: 'Marketing' },
  { to: '/reminders', label: 'Reminders' },
  { to: '/settings', label: 'Settings' },
  { to: '/billing', label: 'Billing' },
  { to: '/help', label: 'Help & FAQ' },
];

// Mounted at free paths (no collision with client routes) so the owner pages'
// internal navigation (e.g. navigate('/tenants/:id')) keeps working unmodified.
const ADMIN_LINKS = [
  { to: '/platform', label: 'Platform' },
  { to: '/tenants', label: 'All Tenants' },
  { to: '/documents', label: 'Documents' },
  { to: '/audit', label: 'Audit Log' },
];

export default function ClientApp({ isPlatformAdmin = false }) {
  return (
    <AppShell scope="client" links={LINKS} adminLinks={isPlatformAdmin ? ADMIN_LINKS : null}>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="leads" element={<Leads />} />
        <Route path="chat" element={<Chats />} />
        <Route path="calls" element={<Calls />} />
        <Route path="time-tickets" element={<TimeTickets />} />
        <Route path="outbound" element={<OutboundLeads />} />
        <Route path="integrations" element={<IntegrationSettings />} />
        <Route path="marketing" element={<Marketing />} />
        <Route path="reminders" element={<Reminders />} />
        <Route path="settings" element={<Settings />} />
        <Route path="billing" element={<Billing />} />
        <Route path="help" element={<Help />} />
        {isPlatformAdmin && [
          <Route key="platform" path="platform" element={<PlatformOverview />} />,
          <Route key="tenants" path="tenants" element={<Tenants />} />,
          <Route key="tenant-detail" path="tenants/:id" element={<TenantDetail />} />,
          <Route key="documents" path="documents" element={<Documents />} />,
          <Route key="audit" path="audit" element={<AuditLog />} />,
        ]}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
