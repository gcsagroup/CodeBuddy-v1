import * as Popover from '@radix-ui/react-popover';
import { MessageCircleQuestion } from 'lucide-react';
import type { Message, MessageContent, ActionRequired } from '../types/message';
import { defineMessages, useIntl } from '../i18n';
import ElicitationRequest from './ElicitationRequest';
import type { JsonSchema } from './ui/JsonSchemaForm';

const i18n = defineMessages({
  reply: { id: 'elicitationRequest.replyLater', defaultMessage: 'Answer question' },
});

type ElicitationContent = ActionRequired & { type: 'actionRequired' };

// Move only live requests for presentation. The session's original messages stay untouched.
export function partitionElicitationMessages(messages: Message[], requests: ElicitationContent[]) {
  const pending = new Set(requests.map((request) => request.data.id));
  const history: Message[] = [];
  for (const message of messages) {
    if (!message.metadata.userVisible) {
      history.push(message);
      continue;
    }
    const content: MessageContent[] = [];
    for (const item of message.content) {
      if (
        item.type === 'actionRequired' &&
        item.data.actionType === 'elicitation' &&
        pending.has(item.data.id)
      ) {
        continue;
      } else {
        content.push(item);
      }
    }
    if (content.length === message.content.length) history.push(message);
    else if (content.length) history.push({ ...message, content });
  }
  return { history, requests };
}

interface ElicitationDockProps {
  requests: ElicitationContent[];
  onSubmit: React.ComponentProps<typeof ElicitationRequest>['onSubmit'];
}

export default function ElicitationDock({ requests, onSubmit }: ElicitationDockProps) {
  const intl = useIntl();
  if (!requests.length) return null;
  return (
    <div className="mx-4 mb-2">
      <div className="mx-auto flex max-h-[min(50vh,28rem)] w-full max-w-[46rem] flex-col gap-2 overflow-y-auto">
        {requests.map((request) => {
          const card = (
            <ElicitationRequest
              key={request.data.id}
              standalone
              isCancelledMessage={false}
              isClicked={false}
              actionRequiredContent={request}
              onSubmit={onSubmit}
            />
          );
          if (request.data.actionType !== 'elicitation' || !request.data.continued) return card;
          const question = Object.values(
            (request.data.requested_schema as JsonSchema)?.properties ?? {}
          )[0]?.title;
          return (
            <Popover.Root key={request.data.id}>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  className="flex max-w-full items-center gap-1.5 self-end rounded-full border border-border-primary bg-background-primary px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <MessageCircleQuestion className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="shrink-0">{intl.formatMessage(i18n.reply)}</span>
                  {typeof question === 'string' && <span className="truncate">· {question}</span>}
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  side="top"
                  align="end"
                  sideOffset={8}
                  collisionPadding={16}
                  className="z-[110] w-[min(32rem,calc(100vw-2rem))] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-2xl bg-background-primary shadow-md"
                >
                  {card}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          );
        })}
      </div>
    </div>
  );
}
