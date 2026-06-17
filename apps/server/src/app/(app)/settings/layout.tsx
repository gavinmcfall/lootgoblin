// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SettingsTabs } from '@/components/shell/SettingsTabs';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <SettingsTabs />
      {children}
    </div>
  );
}
