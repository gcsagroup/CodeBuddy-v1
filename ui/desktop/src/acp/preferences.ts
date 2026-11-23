import type {
  PreferenceKey,
  PreferencesReadResponse_unstable,
  PreferenceValue,
} from '@aaif/goose-sdk';
import { getAcpClient, getAcpControlClient } from './acpConnection';

type GoosePreferencesClient = Awaited<ReturnType<typeof getAcpClient>>['goose'];

let mutationQueue: Promise<void> = Promise.resolve();

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function isSafeRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateSnapshot(
  snapshot: PreferencesReadResponse_unstable
): PreferencesReadResponse_unstable {
  if (!isSafeRevision(snapshot.revision)) {
    throw new Error('Invalid preferences revision');
  }
  return snapshot;
}

async function readWithClient(
  goose: GoosePreferencesClient,
  keys: PreferenceKey[]
): Promise<PreferencesReadResponse_unstable> {
  return validateSnapshot(await goose.preferencesRead_unstable({ keys }));
}

function conflictData(reason: unknown): Record<string, unknown> | null {
  const root = asRecord(reason);
  if (!root) return null;

  let envelope = root;
  if (hasOwn(root, 'error')) {
    const nested = asRecord(root.error);
    if (!nested) return null;
    envelope = nested;
  }
  if (!hasOwn(envelope, 'data')) return null;

  const data = asRecord(envelope.data);
  if (
    !data ||
    !hasOwn(data, 'code') ||
    !hasOwn(data, 'expectedRevision') ||
    !hasOwn(data, 'actualRevision')
  ) {
    return null;
  }
  return data;
}

function isPreferenceRevisionConflict(reason: unknown): boolean {
  const data = conflictData(reason);
  return (
    data?.code === 'preference_revision_conflict' &&
    isSafeRevision(data.expectedRevision) &&
    isSafeRevision(data.actualRevision)
  );
}

function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(task, task);
  mutationQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export async function readPreferences(
  keys: PreferenceKey[],
  control = false
): Promise<PreferencesReadResponse_unstable> {
  const client = await (control ? getAcpControlClient() : getAcpClient());
  return readWithClient(client.goose, keys);
}

async function mutatePreferences(
  keys: PreferenceKey[],
  mutate: (goose: GoosePreferencesClient, expectedRevision: number) => Promise<void>
): Promise<PreferencesReadResponse_unstable> {
  return enqueueMutation(async () => {
    const client = await getAcpClient();
    let snapshot = await readWithClient(client.goose, keys);

    try {
      await mutate(client.goose, snapshot.revision);
    } catch (reason) {
      if (!isPreferenceRevisionConflict(reason)) throw reason;
      snapshot = await readWithClient(client.goose, keys);
      await mutate(client.goose, snapshot.revision);
    }

    return readWithClient(client.goose, keys);
  });
}

export async function savePreferences(
  values: PreferenceValue[]
): Promise<PreferencesReadResponse_unstable> {
  const keys = [...new Set(values.map(({ key }) => key))];
  return mutatePreferences(keys, (goose, expectedRevision) =>
    goose.preferencesSave_unstable({ expectedRevision, values })
  );
}

export async function removePreferences(
  keys: PreferenceKey[]
): Promise<PreferencesReadResponse_unstable> {
  const uniqueKeys = [...new Set(keys)];
  return mutatePreferences(uniqueKeys, (goose, expectedRevision) =>
    goose.preferencesRemove_unstable({ expectedRevision, keys: uniqueKeys })
  );
}
