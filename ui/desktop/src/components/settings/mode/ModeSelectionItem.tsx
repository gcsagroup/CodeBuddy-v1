import { useEffect, useState, forwardRef } from 'react';
import { Gear } from '../../icons';
import { ConfigureApproveMode } from './ConfigureApproveMode';
import PermissionRulesModal from '../permission/PermissionRulesModal';
import { defineMessages, useIntl } from '../../../i18n';

const i18n = defineMessages({
  permissionRules: {
    id: 'permissionRulesModal.title',
    defaultMessage: 'Permission Rules',
  },
  autonomousLabel: {
    id: 'modeSelectionItem.autonomousLabel',
    defaultMessage: 'Full access',
  },
  autonomousDescription: {
    id: 'modeSelectionItem.autonomousDescription',
    defaultMessage:
      'Run without the file and command sandbox. Explicit tool restrictions still apply; operations requiring approval cannot ask.',
  },
  manualLabel: {
    id: 'modeSelectionItem.manualLabel',
    defaultMessage: 'Read only',
  },
  manualDescription: {
    id: 'modeSelectionItem.manualDescription',
    defaultMessage:
      'Read files and run commands under the read-only sandbox. Operations outside the sandbox may request approval.',
  },
  smartLabel: {
    id: 'modeSelectionItem.smartLabel',
    defaultMessage: 'Workspace write',
  },
  smartDescription: {
    id: 'modeSelectionItem.smartDescription',
    defaultMessage:
      'Read files and run commands with writes confined to the workspace and platform temporary areas. Operations outside the sandbox may request approval.',
  },
  chatOnlyLabel: {
    id: 'modeSelectionItem.chatOnlyLabel',
    defaultMessage: 'Chat only',
  },
  chatOnlyDescription: {
    id: 'modeSelectionItem.chatOnlyDescription',
    defaultMessage: 'Engage with the selected provider without using tools or extensions.',
  },
});

export interface GooseMode {
  key: string;
  labelDescriptor: { id: string; defaultMessage: string };
  descriptionDescriptor: { id: string; defaultMessage: string };
}

export const all_goose_modes: GooseMode[] = [
  {
    key: 'read-only',
    labelDescriptor: i18n.manualLabel,
    descriptionDescriptor: i18n.manualDescription,
  },
  {
    key: 'workspace-write',
    labelDescriptor: i18n.smartLabel,
    descriptionDescriptor: i18n.smartDescription,
  },
  {
    key: 'danger-full-access',
    labelDescriptor: i18n.autonomousLabel,
    descriptionDescriptor: i18n.autonomousDescription,
  },
];

interface ModeSelectionItemProps {
  currentMode: string;
  mode: GooseMode;
  showDescription: boolean;
  isApproveModeConfigure: boolean;
  disabled?: boolean;
  handleModeChange: (newMode: string) => void | Promise<void>;
}

export const ModeSelectionItem = forwardRef<HTMLDivElement, ModeSelectionItemProps>(
  (
    {
      currentMode,
      mode,
      showDescription,
      isApproveModeConfigure,
      disabled = false,
      handleModeChange,
    },
    ref
  ) => {
    const intl = useIntl();
    const [checked, setChecked] = useState(currentMode == mode.key);
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [isPermissionModalOpen, setIsPermissionModalOpen] = useState(false);

    useEffect(() => {
      setChecked(currentMode === mode.key);
    }, [currentMode, mode.key]);

    return (
      <div
        ref={ref}
        className={`group text-sm ${disabled ? 'opacity-50' : 'hover:cursor-pointer'}`}
      >
        <div
          className={`flex items-center justify-between text-text-primary py-2 px-2 ${checked ? 'bg-background-secondary' : 'bg-background-primary hover:bg-background-secondary'} rounded-lg transition-all`}
          aria-disabled={disabled}
          onClick={() => {
            if (!disabled) void handleModeChange(mode.key);
          }}
        >
          <div className="flex">
            <div>
              <h3 className="text-text-primary">{intl.formatMessage(mode.labelDescriptor)}</h3>
              {showDescription && (
                <p className="text-text-secondary mt-[2px]">
                  {intl.formatMessage(mode.descriptionDescriptor)}
                </p>
              )}
            </div>
          </div>

          <div className="relative flex items-center gap-2">
            {!isApproveModeConfigure && mode.key !== 'danger-full-access' && (
              <button
                type="button"
                aria-label={intl.formatMessage(i18n.permissionRules)}
                onClick={(e) => {
                  e.stopPropagation(); // Prevent triggering the mode change
                  setIsPermissionModalOpen(true);
                }}
              >
                <Gear className="w-4 h-4 text-text-secondary hover:text-text-primary" />
              </button>
            )}
            <input
              type="radio"
              name="modes"
              value={mode.key}
              aria-label={intl.formatMessage(mode.labelDescriptor)}
              checked={checked}
              disabled={disabled}
              onChange={() => void handleModeChange(mode.key)}
              className="peer sr-only"
            />
            <div
              className="h-4 w-4 rounded-full border border-border-primary 
                    peer-checked:border-[6px] peer-checked:border-black dark:peer-checked:border-white
                    peer-checked:bg-white dark:peer-checked:bg-black
                    transition-all duration-200 ease-in-out group-hover:border-border-primary"
            ></div>
          </div>
        </div>
        <div>
          <div>
            {isDialogOpen ? (
              <ConfigureApproveMode
                onClose={() => {
                  setIsDialogOpen(false);
                }}
                handleModeChange={handleModeChange}
                currentMode={currentMode}
              />
            ) : null}
          </div>
        </div>

        <PermissionRulesModal
          isOpen={isPermissionModalOpen}
          onClose={() => setIsPermissionModalOpen(false)}
        />
      </div>
    );
  }
);

ModeSelectionItem.displayName = 'ModeSelectionItem';
