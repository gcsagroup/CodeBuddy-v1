import Stop from './ui/Stop';
import { Button } from './ui/button';

interface ChatInputStopButtonProps {
  label: string;
  onStop: () => void;
}

export function ChatInputStopButton({ label, onStop }: ChatInputStopButtonProps) {
  return (
    <Button
      type="button"
      onClick={onStop}
      size="sm"
      shape="round"
      variant="ghost"
      aria-label={label}
      title={label}
      className="bg-destructive/10 text-destructive ring-1 ring-destructive/30 hover:bg-destructive/20"
    >
      <span aria-hidden="true">
        <Stop />
      </span>
    </Button>
  );
}
