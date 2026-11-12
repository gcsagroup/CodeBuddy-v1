import React from 'react';
import { cn } from '../utils';

/**
 * Shared visual wrapper for the ChatInput.
 *
 * Both the Hub (empty-chat landing) and the BaseChat (active session)
 * present ChatInput as a floating rounded outlined card on the canvas.
 * Centralizing it here keeps the look in sync and gives a single place
 * to tweak the recipe.
 */
export const ChatInputCard: React.FC<React.ComponentPropsWithoutRef<'div'>> = ({
  className,
  children,
  ...props
}) => (
  <div
    {...props}
    className={cn(
      'shell-composer-card rounded-2xl border border-border-primary/50 shadow-[0_2.5px_12px_rgba(0,0,0,0.05),0_1px_2.5px_rgba(0,0,0,0.022)] dark:border-border-primary dark:shadow-sm overflow-hidden bg-background-primary',
      className
    )}
  >
    {children}
  </div>
);
