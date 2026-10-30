import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { CustomAgents } from '../../src/components/custom-agents/CustomAgents';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
import '../../src/styles/main.css';
applyThemeTokens(new URLSearchParams(location.search).has('dark') ? 'dark' : 'light');
function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname + location.search}</output>; }
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/custom-agents']}><div style={{ height: 'calc(100vh - 24px)' }}><CustomAgents /></div><Location /></MemoryRouter>);
