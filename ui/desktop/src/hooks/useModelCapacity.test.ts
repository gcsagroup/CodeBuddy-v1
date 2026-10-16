import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useModelCapacity } from './useModelCapacity';
import { fetchCanonicalModelInfo } from '../utils/canonical';
vi.mock('../utils/canonical', () => ({ fetchCanonicalModelInfo: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const info = (model: string, contextLimit: number) => ({provider:'fixture',model,contextLimit,reasoning:false,currency:'USD'});
it('keeps capacity unknown until the backend replies and discards a late previous-model response', async () => {
  let first!: (value: ReturnType<typeof info>) => void;
  let second!: (value: ReturnType<typeof info>) => void;
  vi.mocked(fetchCanonicalModelInfo).mockImplementation((_p,m) => new Promise(r => {if(m==='old')first=r;else second=r;}));
  const {result,rerender}=renderHook(({model}) => useModelCapacity('fixture',model,128000),{initialProps:{model:'old'}});
  expect(result.current).toBeNull();
  rerender({model:'kimi'});
  expect(result.current).toBeNull();
  await act(async()=>second(info('kimi',1048576)));
  expect(result.current?.contextLimit).toBe(1048576);
  await act(async()=>first(info('old',32768)));
  expect(result.current?.contextLimit).toBe(1048576);
});
it('does not invent a capacity when the backend has no metadata', async () => {
  vi.mocked(fetchCanonicalModelInfo).mockResolvedValue(null);
  const {result}=renderHook(()=>useModelCapacity('fixture','unknown'));
  await waitFor(()=>expect(fetchCanonicalModelInfo).toHaveBeenCalledTimes(1));
  expect(result.current).toBeNull();
});
