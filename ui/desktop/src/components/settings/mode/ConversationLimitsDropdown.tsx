import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Input } from '../../ui/input';
import { defineMessages, useIntl } from '../../../i18n';

const i18n = defineMessages({
  conversationLimits: {
    id: 'conversationLimitsDropdown.conversationLimits',
    defaultMessage: 'Conversation Limits',
  },
  maxTurns: {
    id: 'conversationLimitsDropdown.maxTurns',
    defaultMessage: 'Max Turns',
  },
  maxTurnsDescription: {
    id: 'conversationLimitsDropdown.maxTurnsDescription',
    defaultMessage: 'Maximum agent turns before CodeBuddy asks for user input',
  },
});

interface ConversationLimitsDropdownProps {
  maxTurns: number | null;
  disabled: boolean;
  isSaving: boolean;
  onMaxTurnsChange: (value: number) => Promise<number | null>;
}

export const ConversationLimitsDropdown = ({
  maxTurns,
  disabled,
  isSaving,
  onMaxTurnsChange,
}: ConversationLimitsDropdownProps) => {
  const intl = useIntl();
  const [isExpanded, setIsExpanded] = useState(false);
  const [draft, setDraft] = useState(maxTurns === null ? '' : String(maxTurns));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitInFlightRef = useRef(false);
  const draftDirtyRef = useRef(false);

  useEffect(() => {
    if (!draftDirtyRef.current) {
      setDraft(maxTurns === null ? '' : String(maxTurns));
    }
  }, [maxTurns]);

  const parsedDraft = Number(draft);
  const draftIsValid =
    draft.trim() !== '' &&
    Number.isInteger(parsedDraft) &&
    parsedDraft >= 1 &&
    parsedDraft <= 10_000;

  const submitDraft = async (currentDraft: string) => {
    const value = Number(currentDraft);
    const isValid =
      currentDraft.trim() !== '' && Number.isInteger(value) && value >= 1 && value <= 10_000;
    if (disabled || isSaving || submitInFlightRef.current || !isValid) {
      return;
    }

    submitInFlightRef.current = true;
    setIsSubmitting(true);
    try {
      const authoritativeMaxTurns = await onMaxTurnsChange(value);
      if (authoritativeMaxTurns !== null) {
        draftDirtyRef.current = false;
        setDraft(String(authoritativeMaxTurns));
      }
    } catch {
      // The parent owns error reporting; keep the draft available for retry.
    } finally {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
    }
  };

  const toggleExpanded = () => {
    setIsExpanded(!isExpanded);
  };

  return (
    <div className="pt-4">
      <button
        onClick={toggleExpanded}
        className="w-full flex items-center justify-between py-2 px-2 hover:bg-background-secondary rounded-lg transition-all group"
      >
        <h3 className="text-text-primary">{intl.formatMessage(i18n.conversationLimits)}</h3>

        <ChevronDown
          className={`w-4 h-4 text-text-secondary transition-transform duration-200 ease-in-out ${
            isExpanded ? 'rotate-180' : 'rotate-0'
          }`}
        />
      </button>

      <div
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          isExpanded ? 'max-h-96 opacity-100 mt-2' : 'max-h-0 opacity-0 mt-0'
        }`}
      >
        <div className="space-y-3 pb-2">
          <div className="flex items-center justify-between py-2 px-2 bg-background-secondary rounded-lg transform transition-all duration-200 ease-in-out">
            <div>
              <h4 className="text-text-primary text-sm">{intl.formatMessage(i18n.maxTurns)}</h4>
              <p className="text-xs text-text-secondary mt-[2px]">
                {intl.formatMessage(i18n.maxTurnsDescription)}
              </p>
            </div>
            <Input
              type="number"
              min="1"
              max="10000"
              value={draft}
              onChange={(event) => {
                draftDirtyRef.current = true;
                setDraft(event.target.value);
              }}
              onBlur={(event) => void submitDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void submitDraft(event.currentTarget.value);
                }
              }}
              aria-invalid={!draftIsValid}
              disabled={disabled || isSaving || isSubmitting}
              className="w-20"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
