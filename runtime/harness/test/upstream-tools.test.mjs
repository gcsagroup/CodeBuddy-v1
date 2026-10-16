import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessDriver } from '../index.mjs';

test('upstream public fetch keeps permission and public-address boundaries', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-upstream-tools-'));
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'state'), cwd: root });
  t.after(() => driver.close());
  const { sessionId } = await driver.createSession({ cwd: root,
    provider: { id: 'offline', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'unused' }, model: 'fixture' });
  const tools = await driver.listTools(sessionId);
  assert.ok(tools.some(tool => tool.name === 'web_fetch'));
  assert.ok(!tools.some(tool => tool.name === 'web_search'), 'do not expose an unconfigured search provider');
  const denied = await driver.callTool(sessionId, 'web_fetch', { url: 'https://example.com' }, { onPermission: () => false });
  assert.equal(denied.isError, true);
  for (const url of ['http://127.0.0.1:1', 'file:///C:/Windows/win.ini']) {
    const result = await driver.callTool(sessionId, 'web_fetch', { url }, { onPermission: () => true });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /WEB_|http|public|URL/);
  }
});

test('official Office skills use the relocatable payload through Harness shell', {
  skip: !existsSync(fileURLToPath(new URL('../../py/runtime.json', import.meta.url))),
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-office-test-'));
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'state'), cwd: root });
  t.after(() => driver.close());
  const { sessionId } = await driver.createSession({ cwd: root,
    provider: { id: 'offline', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'unused' }, model: 'fixture' });
  const skills = await driver.listSkills(sessionId);
  const visible = await driver.listBuiltinSkills(root);
  assert.ok(visible.some(skill => skill.name === 'office-docx' && skill.content.includes('python-docx')));
  for (const name of ['office-docx', 'office-xlsx', 'office-pptx']) {
    assert.ok(skills.some(skill => skill.name === name && skill.provider === 'dsh-office'));
    const loaded = await driver.callTool(sessionId, 'skill', { name }, { onPermission: () => true });
    assert.equal(loaded.isError, false);
    assert.match(JSON.stringify(loaded), /Installed LibreOffice Kit/);
  }
  const denied = await driver.callTool(sessionId, 'load_workspace_dependencies', {}, { onPermission: () => false });
  assert.equal(denied.isError, true);
  const result = await driver.callTool(sessionId, 'load_workspace_dependencies', {}, { onPermission: () => true });
  assert.equal(result.isError, false);
  const payload = result.value;
  assert.ok(payload.python.startsWith(fileURLToPath(new URL('../../py/', import.meta.url))));
  const script = path.join(root, 'office_roundtrip.py');
  await writeFile(script, `import json
from pathlib import Path
from docx import Document
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font
from PIL import Image
root=Path(__file__).parent
Image.new('RGB',(12,12),(20,80,140)).save(root/'image.png')
doc=Document()
doc.add_heading('Harness Office 验收',level=1)
doc.add_paragraph().add_run('KEEP_FORMAT').bold=True
doc.add_paragraph('OLD_TEXT')
doc.add_picture(str(root/'image.png'))
doc.save(root/'original.docx')
doc=Document(root/'original.docx')
doc.paragraphs[2].runs[0].text='NEW_TEXT'
doc.save(root/'edited.docx')
check=Document(root/'edited.docx')
assert check.paragraphs[1].runs[0].bold and check.paragraphs[2].text=='NEW_TEXT'
assert len(check.inline_shapes)==1
assert Document(root/'original.docx').paragraphs[2].text=='OLD_TEXT'
book=Workbook()
book.active.title='Data'
book.active['A1']=5
book.active['B1']='=A1*2'
book.active['B1'].font=Font(bold=True)
book.create_sheet('Keep')['A1']='KEEP_SHEET'
book.save(root/'original.xlsx')
book=load_workbook(root/'original.xlsx',data_only=False)
book['Data']['A1']=7
book.save(root/'edited.xlsx')
check=load_workbook(root/'edited.xlsx',data_only=False)
assert check['Data']['A1'].value==7 and check['Data']['B1'].value=='=A1*2'
assert check['Data']['B1'].font.bold and check['Keep']['A1'].value=='KEEP_SHEET'
assert load_workbook(root/'original.xlsx')['Data']['A1'].value==5
(root/'receipt.json').write_text(json.dumps({'docx':True,'xlsx':True}),encoding='utf-8')
`);
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const shell = await driver.callTool(sessionId, process.platform === 'win32' ? 'pwsh' : 'bash', {
    description: 'Verify Office files preserve unrelated content',
    command: `${process.platform === 'win32' ? '& ' : ''}${quote(payload.python)} -I -B ${quote(script)}`,
  }, { onPermission: () => true });
  assert.equal(shell.isError, false, JSON.stringify(shell));
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'receipt.json'), 'utf8')), { docx: true, xlsx: true });
});
