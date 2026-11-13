export default function AnimatedIcons({ className = '' }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`activity-dots ${className}`}>
      <i /><i /><i />
    </span>
  );
}
