import type { Message, MessageContent, ActionRequired } from '../types/message';
import ElicitationRequest from './ElicitationRequest';

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
  if (!requests.length) return null;
  return (
    <div className="mx-4 mb-2">
      <div className="mx-auto flex max-h-[min(50vh,28rem)] w-full max-w-[46rem] flex-col gap-2 overflow-y-auto">
        {requests.map((request) => (
          <ElicitationRequest
            key={request.data.id}
            standalone
            isCancelledMessage={false}
            isClicked={false}
            actionRequiredContent={request}
            onSubmit={onSubmit}
          />
        ))}
      </div>
    </div>
  );
}
