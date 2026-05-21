// Owner (platform admin) dashboard shell + nested routes.

import { Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from '../../components/Sidebar';
import PlatformOverview from './PlatformOverview';
import Tenants from './Tenants';
import TenantDetail from './TenantDetail';
import Documents from './Documents';
import AuditLog from './AuditLog';

const LINKS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/tenants', label: 'Tenants' },
  { to: '/documents', label: 'Documents' },
  { to: '/audit', label: 'Audit log' },
];

export default function OwnerApp() {
  return (
    <AppShell scope="owner" links={LINKS}>
      <Routes>
        <Route index element={<PlatformOverview />} />
        <Route path="tenants" element={<Tenants />} />
        <Route path="tenants/:id" element={<TenantDetail />} />
        <Route path="documents" element={<Documents />} />
        <Route path="audit" element={<AuditLog />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
