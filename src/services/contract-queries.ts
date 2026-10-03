import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConsumerConfirmationState, ReviewState } from '../models/contract';
import {
  addExemption,
  confirmConsumerChange,
  createFreezeBatch,
  deleteFreezeBatch,
  freezeVersion,
  getContract,
  listContracts,
  listFreezeBatches,
  recalculateChanges,
  resumeFreezeBatch,
  reviewChange,
  saveContract,
  setFailNextFreeze,
  updateContractOpenApi,
  bulkReviewChanges,
} from './contract-service';

export const contractKeys = {
  all: ['contracts'] as const,
  detail: (id: string) => ['contracts', id] as const,
  batches: ['freeze-batches'] as const,
};

export function useContracts() {
  return useQuery({
    queryKey: contractKeys.all,
    queryFn: listContracts,
  });
}

export function useContract(id: string) {
  return useQuery({
    queryKey: contractKeys.detail(id),
    queryFn: () => getContract(id),
    enabled: Boolean(id),
  });
}

export function useFreezeBatches() {
  return useQuery({
    queryKey: contractKeys.batches,
    queryFn: async () => listFreezeBatches(),
    initialData: [],
  });
}

export function useReviewChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      contractId: string;
      changeId: string;
      state: ReviewState;
      reviewer: string;
      comment: string;
    }) =>
      reviewChange(
        input.contractId,
        input.changeId,
        input.state,
        input.reviewer,
        input.comment,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useBulkReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      selections: Array<{ contractId: string; changeId: string }>;
      state: ReviewState;
      reviewer: string;
      comment: string;
    }) =>
      bulkReviewChanges(
        input.selections,
        input.state,
        input.reviewer,
        input.comment,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useUpdateOpenApi() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contractId: string; openapi: string; expectedRevision?: number }) =>
      updateContractOpenApi(input.contractId, input.openapi, input.expectedRevision),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useRecalculateChanges() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (contractId: string) => recalculateChanges(contractId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useSaveContract() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contract: Parameters<typeof saveContract>[0]; expectedRevision?: number }) =>
      saveContract(input.contract, input.expectedRevision),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useAddExemption() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contractId: string; changeId: string; reason: string }) =>
      addExemption(input.contractId, input.changeId, input.reason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useFreezeVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contractId: string; version: string; notes: string }) =>
      freezeVersion(input.contractId, input.version, input.notes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: contractKeys.all });
      queryClient.invalidateQueries({ queryKey: contractKeys.batches });
    },
  });
}

export function useConfirmConsumer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      contractId: string;
      changeId: string;
      consumerId: string;
      state: ConsumerConfirmationState;
      note: string;
      reviewer: string;
    }) => confirmConsumerChange(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useCreateFreezeBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      items: Array<{ contractId: string; version: string; notes: string }>;
    }) => createFreezeBatch(input.items),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: contractKeys.all });
      queryClient.invalidateQueries({ queryKey: contractKeys.batches });
    },
  });
}

export function useResumeFreezeBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) => resumeFreezeBatch(batchId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: contractKeys.all });
      queryClient.invalidateQueries({ queryKey: contractKeys.batches });
    },
  });
}

export function useDeleteFreezeBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (batchId: string) => deleteFreezeBatch(batchId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.batches }),
  });
}

export function useFailNextFreeze() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => setFailNextFreeze(enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.batches }),
  });
}
