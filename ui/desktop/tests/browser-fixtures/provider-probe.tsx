import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import type { UpdateCustomProviderRequest } from '../../src/types/providers';
import '../../src/styles/main.css';

const bridge = window as unknown as {
  discoverFixture: (data: UpdateCustomProviderRequest) => Promise<string[]>;
  saveFixture: (data: UpdateCustomProviderRequest) => Promise<{ error?: unknown }>;
};
Object.assign(window, { appConfig: { get: () => undefined }, electron: { platform: 'win32', logInfo: () => {} } });
const { default: CustomProviderForm } = await import('../../src/components/settings/providers/modal/subcomponents/forms/CustomProviderForm');
function Fixture() {
  const [saved, setSaved] = useState(false);
  return <IntlProvider locale="en" messages={{}}><main style={{ maxWidth: 650, margin: '20px auto' }}>
    <CustomProviderForm initialData={null} isEditable compactSetup discoverModels={bridge.discoverFixture}
      onSubmit={async data => { const result = await bridge.saveFixture(data); if (result.error) throw result.error; setSaved(true); }} onCancel={() => {}} />
    {saved && <p>Connection saved</p>}
  </main></IntlProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
