import GooseLogo from './GooseLogo';

interface ConversationSpinnerProps {
  size?: 'small' | 'large';
}

export default function ConversationSpinner({ size = 'small' }: ConversationSpinnerProps) {
  if (size === 'large') {
    return (
      <span aria-hidden="true" className="conversation-loading-brand conversation-loading-brand--compact">
        <GooseLogo hover={false} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="conversation-loading-spinner"
    />
  );
}
