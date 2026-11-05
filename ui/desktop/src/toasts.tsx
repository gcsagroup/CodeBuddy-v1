import { cssTransition, toast, ToastOptions } from 'react-toastify';
import './components/extension-toast.css';
import { Button } from './components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './components/ui/Tooltip';
import Copy from './components/icons/Copy';
import { startNewSession } from './sessions';
import { useNavigation } from './hooks/useNavigation';
import {
  GroupedExtensionLoadingToast,
  ExtensionLoadingStatus,
} from './components/GroupedExtensionLoadingToast';
import { getInitialWorkingDir } from './utils/workingDir';
import { defineMessages, useIntl } from './i18n';

const i18n = defineMessages({
  askCodeBuddy: {
    id: 'toasts.askCodeBuddy',
    defaultMessage: 'Ask CodeBuddy',
  },
  copyError: {
    id: 'toasts.copyError',
    defaultMessage: 'Copy error',
  },
});

const extensionToastTransition = cssTransition({
  enter: 'codepro-extension-toast-enter',
  exit: 'codepro-extension-toast-exit',
  collapseDuration: 280,
});

export interface ToastServiceOptions {
  silent?: boolean;
  shouldThrow?: boolean;
}

class ToastService {
  private silent: boolean = false;
  private shouldThrow: boolean = false;

  // Create a singleton instance
  private static instance: ToastService;

  public static getInstance(): ToastService {
    if (!ToastService.instance) {
      ToastService.instance = new ToastService();
    }
    return ToastService.instance;
  }

  configure(options: ToastServiceOptions = {}): void {
    if (options.silent !== undefined) {
      this.silent = options.silent;
    }

    if (options.shouldThrow !== undefined) {
      this.shouldThrow = options.shouldThrow;
    }
  }

  error(props: ToastErrorProps): void {
    if (!this.silent) {
      toastError(props);
    }

    if (this.shouldThrow) {
      throw new Error(props.msg);
    }
  }

  loading({ title, msg }: { title: string; msg: string }): string | number | undefined {
    if (this.silent) {
      return undefined;
    }

    const toastId = toastLoading({ title, msg });

    return toastId;
  }

  success({ title, msg }: { title: string; msg: string }): void {
    if (this.silent) {
      return;
    }
    toastSuccess({ title, msg });
  }

  dismiss(toastId?: string | number): void {
    if (toastId) toast.dismiss(toastId);
  }

  /**
   * Create a grouped extension loading toast that can be updated as extensions load
   */
  extensionLoading(
    extensions: ExtensionLoadingStatus[],
    totalCount: number,
    isComplete: boolean = false
  ): string | number {
    if (this.silent) {
      return 'silent';
    }

    const toastId = 'extension-loading';
    const options: ToastOptions = {
      autoClose: isComplete ? 5000 : false,
      closeButton: true,
      closeOnClick: false,
      pauseOnHover: true,
      pauseOnFocusLoss: false,
      transition: extensionToastTransition,
    };

    // Check if toast already exists
    if (toast.isActive(toastId)) {
      // Update existing toast
      toast.update(toastId, {
        render: (
          <GroupedExtensionLoadingToast
            extensions={extensions}
            totalCount={totalCount}
            isComplete={isComplete}
          />
        ),
        ...options,
      });
    } else {
      // Create new toast
      toast(
        <GroupedExtensionLoadingToast
          extensions={extensions}
          totalCount={totalCount}
          isComplete={isComplete}
        />,
        {
          ...commonToastOptions,
          toastId,
          ...options,
        }
      );
    }

    return toastId;
  }

  /**
   * Handle errors with consistent logging and toast notifications
   * Consolidates the functionality of the original handleError function
   */
  handleError(title: string, message: string, options: ToastServiceOptions = {}): void {
    this.configure(options);
    this.error({
      title: title,
      msg: message,
      traceback: message,
    });
  }
}

// Export a singleton instance for use throughout the app
export const toastService = ToastService.getInstance();

// Re-export ExtensionLoadingStatus for convenience
export type { ExtensionLoadingStatus };

const commonToastOptions: ToastOptions = {
  position: 'top-right',
  closeButton: true,
  hideProgressBar: true,
  closeOnClick: true,
  pauseOnHover: true,
  draggable: true,
};

type ToastSuccessProps = { title?: string; msg?: string; toastOptions?: ToastOptions };

export function toastSuccess({ title, msg, toastOptions = {} }: ToastSuccessProps) {
  return toast.success(
    <div className="notification-copy">
      {title && <strong>{title}</strong>}
      {msg && <div>{msg}</div>}
    </div>,
    { ...commonToastOptions, autoClose: 3000, ...toastOptions }
  );
}

type ToastErrorProps = {
  title: string;
  msg: string;
  traceback?: string;
  recoverHints?: string;
};

function ToastErrorContent({
  title,
  msg,
  traceback,
  recoverHints,
}: Omit<ToastErrorProps, 'setView'>) {
  const intl = useIntl();
  const setView = useNavigation();
  const showRecovery = recoverHints && setView;
  const hasBoth = traceback && showRecovery;

  const handleCopyError = async () => {
    if (traceback) {
      try {
        await navigator.clipboard.writeText(traceback);
      } catch (error) {
        console.error('Failed to copy error:', error);
      }
    }
  };

  return (
    <div className="notification-copy">
      <div className="min-w-0">
        {title && <strong className="font-medium">{title}</strong>}
        {msg && <div>{msg}</div>}
      </div>
      <div className="notification-actions">
        {showRecovery && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => startNewSession(recoverHints, setView, getInitialWorkingDir())}
          >
            {intl.formatMessage(i18n.askCodeBuddy)}
          </Button>
        )}
        {hasBoth && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={handleCopyError}
                shape="round"
                aria-label={intl.formatMessage(i18n.copyError)}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="z-[10000]">
              {intl.formatMessage(i18n.copyError)}
            </TooltipContent>
          </Tooltip>
        )}
        {traceback && !hasBoth && (
          <Button size="sm" variant="outline" onClick={handleCopyError}>
            {intl.formatMessage(i18n.copyError)}
          </Button>
        )}
      </div>
    </div>
  );
}

export function toastError({ title, msg, traceback, recoverHints }: ToastErrorProps) {
  return toast.error(
    <ToastErrorContent title={title} msg={msg} traceback={traceback} recoverHints={recoverHints} />,
    { ...commonToastOptions, autoClose: traceback ? false : 5000 }
  );
}

type ToastLoadingProps = {
  title?: string;
  msg?: string;
  toastOptions?: ToastOptions;
};

export function toastLoading({ title, msg, toastOptions }: ToastLoadingProps) {
  return toast.loading(
    <div className="notification-copy">
      {title && <strong>{title}</strong>}
      {msg && <div>{msg}</div>}
    </div>,
    { ...commonToastOptions, autoClose: false, ...toastOptions }
  );
}
