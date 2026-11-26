import {fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {toast} from 'react-toastify';
import {IntlTestWrapper} from '../../i18n/test-utils';
import {acpListSessions,acpImportSession,acpRenameSession} from '../../acp/sessions';
import SessionListView from './SessionListView';
vi.mock('../../acp/sessions',()=>({acpListSessions:vi.fn(),acpImportSession:vi.fn(),acpRenameSession:vi.fn()}));
vi.mock('react-toastify',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}unobserve(){}});const now=new Date().toISOString();vi.mocked(acpListSessions).mockResolvedValue({sessions:[{id:'a',name:'Original',sessionType:'user',workingDir:'D:/fixture',createdAt:now,updatedAt:now,messageCount:1}],nextCursor:null});});
afterEach(()=>vi.unstubAllGlobals());
it('preserves a failed rename draft and rejects empty names submitted with Enter',async()=>{
 vi.mocked(acpRenameSession).mockRejectedValueOnce(new Error('offline'));
 render(<SessionListView onSelectSession={vi.fn()} workspaceMode="unified"/>,{wrapper:IntlTestWrapper});
 await userEvent.click(await screen.findByRole('button',{name:'More actions for Original'}));await userEvent.click(screen.getByTitle('Edit session name'));
 const dialog=screen.getByRole('dialog');const input=within(dialog).getByRole('textbox');fireEvent.change(input,{target:{value:'  '}});fireEvent.keyDown(input,{key:'Enter'});expect(acpRenameSession).not.toHaveBeenCalled();
 fireEvent.change(input,{target:{value:'My new name'}});await userEvent.click(within(dialog).getByRole('button',{name:'Save'}));await waitFor(()=>expect(toast.error).toHaveBeenCalled());expect(input).toHaveValue('My new name');
 await userEvent.click(within(dialog).getByRole('button',{name:'Cancel'}));expect(screen.queryByRole('dialog')).toBeNull();
});
it('handles native import cancellation file errors and a valid file',async()=>{
 const choose=vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({error:'bad file'}).mockResolvedValueOnce({contents:'{"conversation":[]}'});
 Object.assign(window.electron,{selectImportSessionFile:choose});vi.mocked(acpImportSession).mockResolvedValue({} as never);
 render(<SessionListView onSelectSession={vi.fn()} workspaceMode="unified"/>,{wrapper:IntlTestWrapper});await screen.findByText('Original');const button=screen.getByRole('button',{name:'Import Session'});
 await userEvent.click(button);expect(acpImportSession).not.toHaveBeenCalled();await userEvent.click(button);expect(toast.error).toHaveBeenCalledWith('Failed to import session: bad file');expect(acpImportSession).not.toHaveBeenCalled();
 await userEvent.click(button);expect(acpImportSession).toHaveBeenCalledWith('{"conversation":[]}','json');expect(toast.success).toHaveBeenCalledWith('Session imported successfully');
});
