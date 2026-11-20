import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkHistoryWindow } from '../../src/components/WorkHistoryWindow';
import { SearchView } from '../../src/components/conversation/SearchView';
import { IntlTestWrapper } from '../../src/i18n/test-utils';

// The browser fixture supplies only the desktop find-menu event bridge.
window.electron = { platform: 'win32', on() {}, off() {} } as unknown as typeof window.electron;

function Fixture() {
  const [search, setSearch] = useState(false);
  const [count, setCount] = useState(288);
  return <IntlTestWrapper><button onClick={() => setCount(n => n + 1)}>Append receipt</button>
    <SearchView onQueryActiveChange={setSearch} showNavigation>
      <div data-radix-scroll-area-viewport="" style={{ height: '70vh', overflow: 'auto' }}>
        <WorkHistoryWindow keepAllMounted={false} prepareSearch={search} rows={Array.from({ length: count }, (_, i) =>
          <article key={i} data-receipt={i} style={{ minHeight: 100, padding: 12 }}>
            <p>{`Receipt ${i}: synthetic completed tool output`}</p>
            <pre>{`file-${i}.txt\nSaved and verified`}</pre>
            <details><summary>Details {i}</summary>Expanded output {i}</details>
          </article>)} />
      </div>
    </SearchView></IntlTestWrapper>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
