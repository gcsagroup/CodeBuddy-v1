import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import UserMessage from '../../src/components/UserMessage';
import ImagePreview from '../../src/components/ImagePreview';
import type { Message } from '../../src/types/message';
import { applyThemeTokens } from '../../src/theme/theme-tokens';

const dark = new URLSearchParams(location.search).has('dark');
applyThemeTokens(dark ? 'dark' : 'light');
document.documentElement.classList.add(dark ? 'dark' : 'light');
document.documentElement.style.colorScheme = dark ? 'dark' : 'light';

const image = (index: number): Message['content'][number] => ({
  type: 'image',
  mimeType: 'image/svg+xml',
  data: btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${index % 2 ? 320 : 120}" height="${index % 2 ? 120 : 200}" viewBox="0 0 120 200"><rect width="120" height="200" fill="${['#d2e4dd', '#dae4ef', '#f4e5ce'][index % 3]}"/><path d="M16 40h88M16 60h72M16 80h80" stroke="#586b70" stroke-width="3"/><text x="16" y="130" font-size="24">${index + 1}</text></svg>`
  ),
});
const message = (text: string, images: number): Message => ({
  id: `fixture-${text}-${images}`,
  role: 'user',
  created: 1793980000000,
  content: [{ type: 'text', text }, ...Array.from({ length: images }, (_, index) => image(index))],
  metadata: { userVisible: true, agentVisible: true },
});
const cases: [string, Message][] = [
  ['plain', message('你看得见吗', 0)],
  ['attachments', message('你看得见吗', 5)],
  ['overflow', message('请看这些附件。', 10)],
  ['image-only', message('', 1)],
  ['long-text', message('请保留附件上方的位置。'.repeat(16), 2)],
  [
    'failed-image',
    {
      ...message('加载失败也保持排列。', 1),
      content: [
        { type: 'text', text: '加载失败也保持排列。' },
        { type: 'image', mimeType: 'image/png', data: 'invalid' },
      ],
    },
  ],
];

createRoot(document.getElementById('root')!).render(
  <IntlProvider locale="en" defaultLocale="en" messages={{}}>
    <main className="mx-auto max-w-3xl space-y-6 p-5 font-sans text-text-primary">
      {cases.map(([name, item]) => (
        <section key={name} data-case={name}>
          <UserMessage message={item} />
        </section>
      ))}
      <section data-case="inline-preview">
        <ImagePreview src={`data:image/svg+xml;base64,${(image(0) as { data: string }).data}`} />
      </section>
    </main>
  </IntlProvider>
);
