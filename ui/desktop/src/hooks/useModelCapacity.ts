import { useEffect, useState } from 'react';
import { fetchCanonicalModelInfo, type CanonicalModelInfo } from '../utils/canonical';

// Capacity belongs to the backend model resolver. A previous selection or a
// frontend constant must never stand in for a pending authoritative response.
export function useModelCapacity(provider?: string | null, model?: string | null, nativeLimit?: number) {
  const key = JSON.stringify([provider, model, nativeLimit]);
  const [result, setResult] = useState<{ key: string; info: CanonicalModelInfo } | null>(null);
  useEffect(() => {
    let current = true;
    setResult(null);
    if (provider && model) {
      void fetchCanonicalModelInfo(provider, model).then(info => {
        if (current && info && info.provider === provider && info.model === model && info.contextLimit > 0)
          setResult({ key, info });
      });
    }
    return () => { current = false; };
  }, [provider, model, key]);
  return result?.key === key ? result.info : null;
}
