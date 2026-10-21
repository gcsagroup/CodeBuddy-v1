import { useEffect, useRef, useState } from 'react';
import { all_goose_modes, ModeSelectionItem } from './ModeSelectionItem';
import { ConversationLimitsDropdown } from './ConversationLimitsDropdown';
import { readPreferences, savePreferences } from '../../../acp/preferences';
import { defineMessages, useIntl } from '../../../i18n';

const GOOSE_MODE_PREFERENCE = 'gooseMode' as const;
const GOOSE_MAX_TURNS_PREFERENCE = 'gooseMaxTurns' as const;
const DEFAULT_MODE = 'workspace-write';
const DEFAULT_MAX_TURNS = 1000;

type PreferencesSnapshot = Awaited<ReturnType<typeof readPreferences>>;
let modeMutation: Promise<PreferencesSnapshot> | null = null;
let maxTurnsMutation: Promise<PreferencesSnapshot> | null = null;

const i18n = defineMessages({
  notSynchronized: {
    id: 'sessionPermissions.unknown',
    defaultMessage: 'Not synchronized',
  },
  saveError: {
    id: 'codeProModels.saveError',
    defaultMessage: 'Failed to save. Try again later.',
  },
});

async function saveModePreference(value: string): Promise<PreferencesSnapshot> {
  const mutation = savePreferences([{ key: GOOSE_MODE_PREFERENCE, value, isMutable: true }]);
  modeMutation = mutation;
  try {
    return await mutation;
  } finally {
    if (modeMutation === mutation) modeMutation = null;
  }
}

async function readModePreference(): Promise<PreferencesSnapshot> {
  const pendingMutation = modeMutation;
  if (pendingMutation !== null) {
    try {
      await pendingMutation;
    } catch {
      // Read the unchanged authority below after a failed mutation.
    }
  }
  return readPreferences([GOOSE_MODE_PREFERENCE]);
}

function modeFromSnapshot(
  snapshot: PreferencesSnapshot,
  missingValue: string | null
): { value: string; mutable: boolean } | null {
  const entries = snapshot.values.filter(({ key }) => key === GOOSE_MODE_PREFERENCE);
  if (entries.length === 0) {
    return missingValue === null ? null : { value: missingValue, mutable: true };
  }
  if (entries.length !== 1) return null;

  const [{ value, isMutable }] = entries;
  if (value === null && isMutable && missingValue !== null) {
    return { value: missingValue, mutable: true };
  }
  if (typeof value !== 'string' || !all_goose_modes.some((mode) => mode.key === value)) {
    return null;
  }
  return { value, mutable: isMutable };
}

async function saveMaxTurnsPreference(value: number): Promise<PreferencesSnapshot> {
  const mutation = savePreferences([{ key: GOOSE_MAX_TURNS_PREFERENCE, value, isMutable: true }]);
  maxTurnsMutation = mutation;
  try {
    return await mutation;
  } finally {
    if (maxTurnsMutation === mutation) {
      maxTurnsMutation = null;
    }
  }
}

async function readMaxTurnsPreference(): Promise<PreferencesSnapshot> {
  const pendingMutation = maxTurnsMutation;
  if (pendingMutation !== null) {
    try {
      await pendingMutation;
    } catch {
      // A failed mutation leaves the stored authority unchanged; read it below.
    }
  }
  return readPreferences([GOOSE_MAX_TURNS_PREFERENCE]);
}

function maxTurnsFromSnapshot(
  snapshot: PreferencesSnapshot,
  missingValue: number | null
): number | null {
  const entries = snapshot.values.filter(({ key }) => key === GOOSE_MAX_TURNS_PREFERENCE);
  if (entries.length === 0) return missingValue;
  if (entries.length !== 1) return null;

  const value = entries[0].value;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10_000
    ? value
    : null;
}

export const ModeSection = ({
  showMode = true,
  showLimits = true,
}: {
  showMode?: boolean;
  showLimits?: boolean;
} = {}) => {
  const intl = useIntl();
  const saveErrorMessage = intl.formatMessage(i18n.saveError);
  const notSynchronizedMessage = intl.formatMessage(i18n.notSynchronized);
  const [currentMode, setCurrentMode] = useState(DEFAULT_MODE);
  const [modeEditable, setModeEditable] = useState(false);
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [maxTurns, setMaxTurns] = useState<number | null>(null);
  const [maxTurnsEditable, setMaxTurnsEditable] = useState(false);
  const [maxTurnsSaving, setMaxTurnsSaving] = useState(false);
  const maxTurnsSaveInFlightRef = useRef(false);

  const handleModeChange = async (newMode: string) => {
    if (modeSaving || !modeEditable || newMode === currentMode) return;

    setModeSaving(true);
    setModeError(null);
    try {
      const snapshot = await saveModePreference(newMode);
      const authoritativeMode = modeFromSnapshot(snapshot, null);
      if (authoritativeMode === null) throw new Error('Invalid authoritative mode preference');
      setCurrentMode(authoritativeMode.value);
      setModeEditable(authoritativeMode.mutable);
    } catch {
      console.error('Unable to save the default mode preference.');
      setModeError(saveErrorMessage);
    } finally {
      setModeSaving(false);
    }
  };

  useEffect(() => {
    let active = true;
    void readModePreference()
      .then((snapshot) => {
        if (!active) return;
        const authoritativeMode = modeFromSnapshot(snapshot, DEFAULT_MODE);
        if (authoritativeMode === null) {
          setCurrentMode('');
          setModeEditable(false);
          setModeError(notSynchronizedMessage);
          return;
        }
        setCurrentMode(authoritativeMode.value);
        setModeEditable(authoritativeMode.mutable);
      })
      .catch(() => {
        if (!active) return;
        console.error('Unable to load the default mode preference.');
        setCurrentMode('');
        setModeEditable(false);
        setModeError(saveErrorMessage);
      });
    return () => {
      active = false;
    };
  }, [saveErrorMessage, notSynchronizedMessage]);

  const handleMaxTurnsChange = async (value: number): Promise<number | null> => {
    if (
      maxTurnsSaveInFlightRef.current ||
      !maxTurnsEditable ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 10_000
    ) {
      return null;
    }

    maxTurnsSaveInFlightRef.current = true;
    setMaxTurnsSaving(true);
    try {
      const snapshot = await saveMaxTurnsPreference(value);
      const authoritativeMaxTurns = maxTurnsFromSnapshot(snapshot, null);
      if (authoritativeMaxTurns === null) {
        throw new Error('Invalid authoritative max turns preference');
      }
      setMaxTurns(authoritativeMaxTurns);
      return authoritativeMaxTurns;
    } catch {
      console.error('Unable to save the maximum turn preference.');
      return null;
    } finally {
      maxTurnsSaveInFlightRef.current = false;
      setMaxTurnsSaving(false);
    }
  };

  useEffect(() => {
    let active = true;
    const loadMaxTurns = async () => {
      try {
        const snapshot = await readMaxTurnsPreference();
        if (!active) return;
        const authoritativeMaxTurns = maxTurnsFromSnapshot(snapshot, DEFAULT_MAX_TURNS);
        if (authoritativeMaxTurns === null) {
          setMaxTurns(null);
          setMaxTurnsEditable(false);
          return;
        }
        setMaxTurns(authoritativeMaxTurns);
        setMaxTurnsEditable(true);
      } catch {
        if (!active) return;
        console.error('Unable to load the maximum turn preference.');
        setMaxTurns(null);
        setMaxTurnsEditable(false);
      }
    };

    void loadMaxTurns();
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-1">
      {/* Mode Selection */}
      {showMode &&
        all_goose_modes.map((mode) => (
          <ModeSelectionItem
            key={mode.key}
            mode={mode}
            currentMode={currentMode}
            showDescription={true}
            isApproveModeConfigure={false}
            disabled={modeSaving || !modeEditable}
            handleModeChange={handleModeChange}
          />
        ))}

      {showMode && modeError && (
        <p role="alert" className="px-2 pt-1 text-xs text-red-500">
          {modeError}
        </p>
      )}

      {/* Conversation Limits Dropdown */}
      {showLimits && (
        <ConversationLimitsDropdown
          maxTurns={maxTurns}
          disabled={!maxTurnsEditable}
          isSaving={maxTurnsSaving}
          onMaxTurnsChange={handleMaxTurnsChange}
        />
      )}
    </div>
  );
};
