import type { ImageData } from '../types/message';

export interface SubmittedDraftState {
  text: string;
  images: ImageData[];
  revision: number;
  accepted: boolean;
}

export function createSubmittedDraftState(
  text: string,
  images: ImageData[],
  revision: number
): SubmittedDraftState {
  return { text, images, revision, accepted: false };
}

export function acceptSubmittedDraft(
  submitted: SubmittedDraftState,
  currentRevision: number
): { shouldClear: boolean } {
  submitted.accepted = true;
  return { shouldClear: currentRevision === submitted.revision };
}

export function rejectSubmittedDraft(
  submitted: SubmittedDraftState,
  currentRevision: number
): { shouldRestore: false } | { shouldRestore: true; text: string; images: ImageData[] } {
  if (submitted.accepted || currentRevision !== submitted.revision) {
    return { shouldRestore: false };
  }
  return { shouldRestore: true, text: submitted.text, images: submitted.images };
}
