import React, { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { ScheduledJobDto } from '@aaif/goose-sdk';
import {
  acpListSchedules,
  acpDeleteSchedule,
  acpPauseSchedule,
  acpUnpauseSchedule,
  acpUpdateSchedule,
  acpKillRunningJob,
  acpInspectRunningJob,
} from '../../acp/schedules';
import { ScrollArea } from '../ui/scroll-area';
import { Card } from '../ui/card';
import { Button } from '../ui/button';
import { TrashIcon } from '../icons/TrashIcon';
import { Plus, RefreshCw, Pause, Play, Edit, Square, Eye, CircleDotDashed } from 'lucide-react';
import { NewSchedulePayload, ScheduleModal } from './ScheduleModal';
import ScheduleDetailView from './ScheduleDetailView';
import { toastError, toastSuccess } from '../../toasts';
import cronstrue from 'cronstrue';
import { formatToLocalDateWithTimezone } from '../../utils/date';
import { errorMessage } from '../../utils/conversionUtils';
import { MainPanelLayout } from '../Layout/MainPanelLayout';
import { getWorkspaceModeFromPath, ViewOptions } from '../../utils/navigationUtils';
import { schedulesForWorkspace } from '../../utils/scheduleWorkspace';
import { trackScheduleCreated, trackScheduleDeleted, getErrorType } from '../../utils/analytics';
import { defineMessages, useIntl } from '../../i18n';
import { createTestedSchedule } from './createTestedSchedule';
import { useChatContext } from '../../contexts/ChatContext';
import { acpGetSessionListItem } from '../../acp/sessions';

const i18n = defineMessages({
  newSession: { id: 'scheduleModal.newSession', defaultMessage: 'Open a new chat on every run' },
  currentSession: {
    id: 'scheduleModal.currentSession',
    defaultMessage: 'Follow up in the current chat',
  },
  running: { id: 'schedulesView.running', defaultMessage: 'Running' },
  paused: { id: 'schedulesView.paused', defaultMessage: 'Paused' },
  lastRun: { id: 'schedulesView.lastRun', defaultMessage: 'Last run: {date}' },
  edit: { id: 'schedulesView.edit', defaultMessage: 'Edit' },
  resume: { id: 'schedulesView.resume', defaultMessage: 'Resume' },
  pause: { id: 'schedulesView.pause', defaultMessage: 'Pause' },
  inspect: { id: 'schedulesView.inspect', defaultMessage: 'Inspect' },
  kill: { id: 'schedulesView.kill', defaultMessage: 'Kill' },
  scheduler: { id: 'schedulesView.scheduler', defaultMessage: 'Automatic Tasks' },
  refreshing: { id: 'schedulesView.refreshing', defaultMessage: 'Refreshing...' },
  refresh: { id: 'schedulesView.refresh', defaultMessage: 'Refresh' },
  createSchedule: { id: 'schedulesView.createSchedule', defaultMessage: 'Create Schedule' },
  description: {
    id: 'schedulesView.description',
    defaultMessage: 'Schedule recurring work and review the results of each run.',
  },
  errorPrefix: { id: 'schedulesView.errorPrefix', defaultMessage: 'Error: {error}' },
  noSchedules: { id: 'schedulesView.noSchedules', defaultMessage: 'No schedules yet' },
  scheduleUpdated: { id: 'schedulesView.scheduleUpdated', defaultMessage: 'Schedule Updated' },
  scheduleUpdatedMsg: {
    id: 'schedulesView.scheduleUpdatedMsg',
    defaultMessage: 'Successfully updated schedule "{id}"',
  },
  confirmDelete: {
    id: 'schedulesView.confirmDelete',
    defaultMessage: 'Remove schedule "{id}"? The recipe will be kept.',
  },
  schedulePaused: { id: 'schedulesView.schedulePaused', defaultMessage: 'Schedule Paused' },
  schedulePausedMsg: {
    id: 'schedulesView.schedulePausedMsg',
    defaultMessage: 'Successfully paused schedule "{id}"',
  },
  pauseError: { id: 'schedulesView.pauseError', defaultMessage: 'Pause Schedule Error' },
  scheduleUnpaused: { id: 'schedulesView.scheduleUnpaused', defaultMessage: 'Schedule Unpaused' },
  scheduleUnpausedMsg: {
    id: 'schedulesView.scheduleUnpausedMsg',
    defaultMessage: 'Successfully unpaused schedule "{id}"',
  },
  unpauseError: { id: 'schedulesView.unpauseError', defaultMessage: 'Unpause Schedule Error' },
  jobKilled: { id: 'schedulesView.jobKilled', defaultMessage: 'Job Killed' },
  killError: { id: 'schedulesView.killError', defaultMessage: 'Kill Job Error' },
  jobInspection: { id: 'schedulesView.jobInspection', defaultMessage: 'Job Inspection' },
  inspectNoInfo: {
    id: 'schedulesView.inspectNoInfo',
    defaultMessage: 'No detailed information available for this job',
  },
  inspectError: { id: 'schedulesView.inspectError', defaultMessage: 'Inspect Job Error' },
  createTestFailed: {
    id: 'schedulesView.createTestFailed',
    defaultMessage: 'The automatic task test failed. Technical details: {error}',
  },
});

interface SchedulesViewProps {
  onClose?: () => void;
}

const ScheduleCard: React.FC<{
  job: ScheduledJobDto;
  onNavigateToDetail: (id: string) => void;
  onEdit: (job: ScheduledJobDto) => void;
  onPause: (id: string) => void;
  onUnpause: (id: string) => void;
  onKill: (id: string) => void;
  onInspect: (id: string) => void;
  onDelete: (id: string) => void;
  actionInProgress: boolean;
}> = ({
  job,
  onNavigateToDetail,
  onEdit,
  onPause,
  onUnpause,
  onKill,
  onInspect,
  onDelete,
  actionInProgress,
}) => {
  const intl = useIntl();
  let readableCron: string;
  try {
    readableCron = cronstrue.toString(job.cron);
  } catch {
    readableCron = job.cron;
  }

  const formattedLastRun = formatToLocalDateWithTimezone(job.lastRun);

  return (
    <Card
      className="mb-3 cursor-pointer rounded-2xl border border-border-primary bg-background-primary px-5 py-4 shadow-none transition-colors duration-150 hover:bg-background-secondary"
      onClick={() => onNavigateToDetail(job.id)}
    >
      <div className="flex justify-between items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="max-w-[50vw] truncate text-sm font-medium" title={job.id}>
              {job.id}
            </h3>
            {job.currentlyRunning && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                <span className="inline-block w-2 h-2 bg-green-500 rounded-full mr-1 animate-pulse"></span>
                {intl.formatMessage(i18n.running)}
              </span>
            )}
            {job.paused && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300">
                <Pause className="w-3 h-3 mr-1" />
                {intl.formatMessage(i18n.paused)}
              </span>
            )}
          </div>
          <p className="text-text-secondary text-sm mb-2 line-clamp-2" title={readableCron}>
            {readableCron}
          </p>
          <p className="text-xs text-text-secondary mb-2">
            {intl.formatMessage(
              job.executionMode === 'current_session' ? i18n.currentSession : i18n.newSession
            )}
          </p>
          {job.lastError && <p className="text-xs text-text-danger mb-2">{job.lastError}</p>}
          <div className="flex items-center text-xs text-text-secondary">
            <span>{intl.formatMessage(i18n.lastRun, { date: formattedLastRun })}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!job.currentlyRunning && (
            <>
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(job);
                }}
                disabled={actionInProgress}
                variant="outline"
                size="sm"
                className="h-8"
              >
                <Edit className="w-4 h-4 mr-1" />
                {intl.formatMessage(i18n.edit)}
              </Button>
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  if (job.paused) {
                    onUnpause(job.id);
                  } else {
                    onPause(job.id);
                  }
                }}
                disabled={actionInProgress}
                variant="outline"
                size="sm"
                className="h-8"
              >
                {job.paused ? (
                  <>
                    <Play className="w-4 h-4 mr-1" />
                    {intl.formatMessage(i18n.resume)}
                  </>
                ) : (
                  <>
                    <Pause className="w-4 h-4 mr-1" />
                    {intl.formatMessage(i18n.pause)}
                  </>
                )}
              </Button>
            </>
          )}
          {job.currentlyRunning && (
            <>
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  onInspect(job.id);
                }}
                disabled={actionInProgress}
                variant="outline"
                size="sm"
                className="h-8"
              >
                <Eye className="w-4 h-4 mr-1" />
                {intl.formatMessage(i18n.inspect)}
              </Button>
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  onKill(job.id);
                }}
                disabled={actionInProgress}
                variant="outline"
                size="sm"
                className="h-8"
              >
                <Square className="w-4 h-4 mr-1" />
                {intl.formatMessage(i18n.kill)}
              </Button>
            </>
          )}
          <Button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(job.id);
            }}
            disabled={actionInProgress}
            variant="ghost"
            size="sm"
            className="h-8 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            <TrashIcon className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
};

const SchedulesView: React.FC<SchedulesViewProps> = ({ onClose: _onClose }) => {
  const intl = useIntl();
  const hubChat = useChatContext()?.chat;
  const location = useLocation();
  const currentSessionId = location.state?.scheduleSessionId ?? hubChat?.sessionId;
  const [currentChat, setCurrentChat] = useState<{ id: string; name: string }>();
  useEffect(() => {
    let disposed = false;
    setCurrentChat(undefined);
    if (typeof currentSessionId === 'string' && currentSessionId) {
      acpGetSessionListItem(currentSessionId)
        .then((session) => {
          if (!disposed && !session.archivedAt)
            setCurrentChat({ id: session.id, name: session.name });
        })
        .catch(() => {
          /* A deleted chat cannot be offered as a follow-up target. */
        });
    }
    return () => {
      disposed = true;
    };
  }, [currentSessionId]);
  const workspaceMode = getWorkspaceModeFromPath(location.pathname);
  const [schedules, setSchedules] = useState<ScheduledJobDto[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitApiError, setSubmitApiError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<ScheduledJobDto | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [pendingDeepLink, setPendingDeepLink] = useState<string | null>(null);
  const [actionsInProgress, setActionsInProgress] = useState<Set<string>>(new Set());
  const [viewingScheduleId, setViewingScheduleId] = useState<string | null>(null);

  const fetchSchedules = useCallback(async () => {
    setIsLoading(true);
    setApiError(null);
    try {
      const fetchedSchedules = await acpListSchedules();
      setSchedules(schedulesForWorkspace(fetchedSchedules, workspaceMode));
    } catch (error) {
      console.error('Failed to fetch schedules:', error);
      setApiError(errorMessage(error, 'An unknown error occurred while fetching schedules.'));
    } finally {
      setIsLoading(false);
    }
  }, [workspaceMode]);

  useEffect(() => {
    if (viewingScheduleId === null) {
      fetchSchedules();

      const locationState = location.state as ViewOptions | null;
      if (locationState?.pendingScheduleDeepLink) {
        setPendingDeepLink(locationState.pendingScheduleDeepLink);
        setIsModalOpen(true);
        window.history.replaceState({}, document.title);
      }
    }
  }, [fetchSchedules, viewingScheduleId, location.state]);

  useEffect(() => {
    if (viewingScheduleId !== null || actionsInProgress.size > 0) return;

    const intervalId = setInterval(() => {
      if (viewingScheduleId === null && !isRefreshing && !isLoading && !isSubmitting) {
        fetchSchedules();
      }
    }, 15000);

    return () => clearInterval(intervalId);
  }, [
    fetchSchedules,
    viewingScheduleId,
    isRefreshing,
    isLoading,
    isSubmitting,
    actionsInProgress.size,
  ]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await fetchSchedules();
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleModalSubmit = async (payload: NewSchedulePayload | string) => {
    setIsSubmitting(true);
    setSubmitApiError(null);
    try {
      if (editingSchedule) {
        await acpUpdateSchedule(editingSchedule.id, payload as string);
        toastSuccess({
          title: intl.formatMessage(i18n.scheduleUpdated),
          msg: intl.formatMessage(i18n.scheduleUpdatedMsg, { id: editingSchedule.id }),
        });
      } else {
        const newPayload = payload as NewSchedulePayload;
        await createTestedSchedule(newPayload, undefined, (created) => {
          // The model may require approval before this test can finish. Release
          // the form immediately so the user can open the live session.
          setIsModalOpen(false);
          setViewingScheduleId(created.id);
        });
        const sourceType = pendingDeepLink ? 'deeplink' : 'file';
        trackScheduleCreated(sourceType, true);
      }
      await fetchSchedules();
      setIsModalOpen(false);
      setEditingSchedule(null);
    } catch (error) {
      console.error('Failed to save schedule:', error);
      const errorMsg = errorMessage(error, 'Unknown error saving schedule.');
      setSubmitApiError(
        editingSchedule ? errorMsg : intl.formatMessage(i18n.createTestFailed, { error: errorMsg })
      );
      if (!editingSchedule) {
        setViewingScheduleId(null);
        setIsModalOpen(true);
      }

      if (!editingSchedule) {
        const sourceType = pendingDeepLink ? 'deeplink' : 'file';
        trackScheduleCreated(sourceType, false, getErrorType(error));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteSchedule = async (id: string) => {
    if (!window.confirm(intl.formatMessage(i18n.confirmDelete, { id }))) return;

    setActionsInProgress((prev) => new Set(prev).add(id));
    if (viewingScheduleId === id) setViewingScheduleId(null);
    setApiError(null);

    try {
      await acpDeleteSchedule(id);
      trackScheduleDeleted(true);
      await fetchSchedules();
    } catch (error) {
      console.error(`Failed to remove schedule "${id}":`, error);
      const errorMsg = errorMessage(error, `Unknown error removing schedule "${id}".`);
      setApiError(errorMsg);
      trackScheduleDeleted(false, getErrorType(error));
    } finally {
      setActionsInProgress((prev) => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
    }
  };

  const handlePauseSchedule = async (id: string) => {
    setActionsInProgress((prev) => new Set(prev).add(id));
    setApiError(null);

    try {
      await acpPauseSchedule(id);
      toastSuccess({
        title: intl.formatMessage(i18n.schedulePaused),
        msg: intl.formatMessage(i18n.schedulePausedMsg, { id }),
      });
      await fetchSchedules();
    } catch (error) {
      console.error(`Failed to pause schedule "${id}":`, error);
      const errorMsg = errorMessage(error, `Unknown error pausing "${id}".`);
      setApiError(errorMsg);
      toastError({
        title: intl.formatMessage(i18n.pauseError),
        msg: errorMsg,
      });
    } finally {
      setActionsInProgress((prev) => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
    }
  };

  const handleUnpauseSchedule = async (id: string) => {
    setActionsInProgress((prev) => new Set(prev).add(id));
    setApiError(null);

    try {
      await acpUnpauseSchedule(id);
      toastSuccess({
        title: intl.formatMessage(i18n.scheduleUnpaused),
        msg: intl.formatMessage(i18n.scheduleUnpausedMsg, { id }),
      });
      await fetchSchedules();
    } catch (error) {
      console.error(`Failed to unpause schedule "${id}":`, error);
      const errorMsg = errorMessage(error, `Unknown error unpausing "${id}".`);
      setApiError(errorMsg);
      toastError({
        title: intl.formatMessage(i18n.unpauseError),
        msg: errorMsg,
      });
    } finally {
      setActionsInProgress((prev) => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
    }
  };

  const handleKillRunningJob = async (id: string) => {
    setActionsInProgress((prev) => new Set(prev).add(id));
    setApiError(null);

    try {
      const result = await acpKillRunningJob(id);
      toastSuccess({
        title: intl.formatMessage(i18n.jobKilled),
        msg: result.message,
      });
      await fetchSchedules();
    } catch (error) {
      console.error(`Failed to kill running job "${id}":`, error);
      const errorMsg = errorMessage(error, `Unknown error killing job "${id}".`);
      setApiError(errorMsg);
      toastError({
        title: intl.formatMessage(i18n.killError),
        msg: errorMsg,
      });
    } finally {
      setActionsInProgress((prev) => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
    }
  };

  const handleInspectRunningJob = async (id: string) => {
    setActionsInProgress((prev) => new Set(prev).add(id));
    setApiError(null);

    try {
      const result = await acpInspectRunningJob(id);
      if (result.sessionId) {
        const duration = result.runningDurationSeconds
          ? `${Math.floor(result.runningDurationSeconds / 60)}m ${result.runningDurationSeconds % 60}s`
          : 'Unknown';
        toastSuccess({
          title: intl.formatMessage(i18n.jobInspection),
          msg: `Session: ${result.sessionId}\nRunning for: ${duration}`,
        });
      } else {
        toastSuccess({
          title: intl.formatMessage(i18n.jobInspection),
          msg: intl.formatMessage(i18n.inspectNoInfo),
        });
      }
    } catch (error) {
      console.error(`Failed to inspect running job "${id}":`, error);
      const errorMsg = errorMessage(error, `Unknown error inspecting job "${id}".`);
      setApiError(errorMsg);
      toastError({
        title: intl.formatMessage(i18n.inspectError),
        msg: errorMsg,
      });
    } finally {
      setActionsInProgress((prev) => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
    }
  };

  const handleNavigateToDetail = (id: string) => {
    setViewingScheduleId(id);
  };

  return (
    <>
      {viewingScheduleId ? (
        <ScheduleDetailView
          scheduleId={viewingScheduleId}
          onNavigateBack={() => setViewingScheduleId(null)}
        />
      ) : (
        <MainPanelLayout>
          <div className="flex-1 flex flex-col min-h-0">
            <div className="mx-auto w-full max-w-5xl bg-background-primary px-6 pb-6 pt-10">
              <div className="flex flex-col page-transition">
                <div className="flex justify-between items-center mb-1">
                  <h1 className="text-2xl font-semibold tracking-tight">
                    {intl.formatMessage(i18n.scheduler)}
                  </h1>
                  <div className="flex gap-2">
                    <Button
                      onClick={handleRefresh}
                      disabled={isRefreshing || isLoading}
                      variant="outline"
                      size="sm"
                      className="flex items-center gap-2 rounded-full"
                    >
                      <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                      {isRefreshing
                        ? intl.formatMessage(i18n.refreshing)
                        : intl.formatMessage(i18n.refresh)}
                    </Button>
                    <Button
                      onClick={() => {
                        setSubmitApiError(null);
                        setIsModalOpen(true);
                      }}
                      size="sm"
                      className="flex items-center gap-2 rounded-full"
                    >
                      <Plus className="h-4 w-4" />
                      {intl.formatMessage(i18n.createSchedule)}
                    </Button>
                  </div>
                </div>
                <p className="text-sm text-text-secondary mb-1">
                  {intl.formatMessage(i18n.description)}
                </p>
              </div>
            </div>

            <div className="relative mx-auto min-h-0 w-full max-w-5xl flex-1 px-6">
              <ScrollArea className="h-full">
                <div className="h-full relative">
                  {apiError && (
                    <div className="mb-4 p-4 bg-background-danger border border-border-danger rounded-md">
                      <p className="text-text-danger text-sm">
                        {intl.formatMessage(i18n.errorPrefix, { error: apiError })}
                      </p>
                    </div>
                  )}

                  {isLoading && schedules.length === 0 && (
                    <div className="flex justify-center items-center py-12">
                      <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2"></div>
                    </div>
                  )}

                  {!isLoading && !apiError && schedules.length === 0 && (
                    <div className="flex flex-col pt-4 pb-12">
                      <CircleDotDashed className="h-5 w-5 text-text-secondary mb-3.5" />
                      <p className="text-base text-text-secondary font-light mb-2">
                        {intl.formatMessage(i18n.noSchedules)}
                      </p>
                    </div>
                  )}

                  {schedules.length > 0 && (
                    <div className="space-y-2 pb-8">
                      {schedules.map((job) => (
                        <ScheduleCard
                          key={job.id}
                          job={job}
                          onNavigateToDetail={handleNavigateToDetail}
                          onEdit={(schedule) => {
                            setEditingSchedule(schedule);
                            setSubmitApiError(null);
                            setIsModalOpen(true);
                          }}
                          onPause={handlePauseSchedule}
                          onUnpause={handleUnpauseSchedule}
                          onKill={handleKillRunningJob}
                          onInspect={handleInspectRunningJob}
                          onDelete={handleDeleteSchedule}
                          actionInProgress={actionsInProgress.has(job.id) || isSubmitting}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>
        </MainPanelLayout>
      )}

      <ScheduleModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingSchedule(null);
          setSubmitApiError(null);
          setPendingDeepLink(null);
        }}
        onSubmit={handleModalSubmit}
        schedule={editingSchedule}
        isLoadingExternally={isSubmitting}
        apiErrorExternally={submitApiError}
        initialDeepLink={pendingDeepLink}
        workspaceMode={workspaceMode}
        currentChat={currentChat}
      />
    </>
  );
};

export default SchedulesView;
