import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/** 跨窗口写入时，让其他窗口的 TanStack Query 缓存失效并重新拉取。 */
export function StorageRefresher() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const refreshContracts = () => {
      void queryClient.invalidateQueries({ queryKey: ['contracts'] });
    };
    const refreshBatches = () => {
      void queryClient.invalidateQueries({ queryKey: ['freeze-batches'] });
    };
    window.addEventListener('pair-wise:contracts-storage', refreshContracts);
    window.addEventListener('pair-wise:batches-storage', refreshBatches);
    return () => {
      window.removeEventListener('pair-wise:contracts-storage', refreshContracts);
      window.removeEventListener('pair-wise:batches-storage', refreshBatches);
    };
  }, [queryClient]);
  return null;
}
