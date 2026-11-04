import type { IntlShape } from 'react-intl';
import { defineMessages } from '../i18n';
import {
  getSessionGoal,
  pauseSessionGoal,
  setSessionPlanMode,
  changeSessionGoal,
} from '../acp/goals';
import type { UserInput } from '../types/message';
import type { DisplayItem } from './MentionPopover';

export const composerMessages = defineMessages({
  useSkill: { id: 'composerCommands.useSkill', defaultMessage: 'Use the {name} skill to: ' },
  useTool: { id: 'composerCommands.useTool', defaultMessage: 'Use {name} to: ' },
  loadingTool: {
    id: 'composerCommands.loadingTool',
    defaultMessage: 'Connecting the selected tool…',
  },
  toolLoadFailed: {
    id: 'composerCommands.toolLoadFailed',
    defaultMessage:
      'The tool could not be loaded. Your draft is preserved; check its configuration and try again.',
  },
  disabledSkill: {
    id: 'composerCommands.disabledSkill',
    defaultMessage: 'This skill is disabled. Enable it in Toolbox before using it.',
  },
  file: { id: 'composerCommands.file', defaultMessage: 'File' },
  fileHint: { id: 'composerCommands.fileHint', defaultMessage: 'Attach a file to this message' },
  agent: { id: 'composerCommands.agent', defaultMessage: 'Custom agent' },
  agentHint: { id: 'composerCommands.agentHint', defaultMessage: 'Choose or remove the main assistant for this conversation' },
  permission: { id: 'composerCommands.permission', defaultMessage: 'Permissions' },
  permissionHint: {
    id: 'composerCommands.permissionHint',
    defaultMessage: 'Choose how actions are approved',
  },
  model: { id: 'composerCommands.model', defaultMessage: 'Model' },
  modelHint: {
    id: 'composerCommands.modelHint',
    defaultMessage: 'Select the model for this conversation',
  },
  export: { id: 'composerCommands.export', defaultMessage: 'Export conversation' },
  exportHint: {
    id: 'composerCommands.exportHint',
    defaultMessage: 'Download the current conversation as JSON',
  },
  exported: { id: 'composerCommands.exported', defaultMessage: 'Conversation export started.' },
  messagePlaceholder: {
    id: 'composerCommands.messagePlaceholder',
    defaultMessage: 'Send a message, / for commands, @ for files',
  },
  goalPrefix: { id: 'composerCommands.goalPrefix', defaultMessage: 'Goal' },
  editPrefix: { id: 'composerCommands.editPrefix', defaultMessage: 'Edit goal' },
  goalPlaceholder: {
    id: 'composerCommands.goalPlaceholder',
    defaultMessage: 'Describe your goal; the agent will keep working toward it',
  },
  planPlaceholder: {
    id: 'composerCommands.planPlaceholder',
    defaultMessage: 'Describe the task to plan before implementation',
  },
  cancelMode: { id: 'composerCommands.cancelMode', defaultMessage: 'Cancel command input' },
  edited: { id: 'composerCommands.edited', defaultMessage: 'Goal updated.' },
  cleared: {
    id: 'composerCommands.cleared',
    defaultMessage: 'Goal cleared. Conversation and project files are retained.',
  },
  editUsage: {
    id: 'composerCommands.editUsage',
    defaultMessage: 'Type /goal edit followed by the revised objective.',
  },
  goal: { id: 'composerCommands.goal', defaultMessage: 'Goal' },
  goalHint: {
    id: 'composerCommands.goalHint',
    defaultMessage: 'Set or view a long-term goal',
  },
  pause: { id: 'composerCommands.pause', defaultMessage: 'Pause goal' },
  pauseHint: {
    id: 'composerCommands.pauseHint',
    defaultMessage: 'Pause the saved goal and stop its current turn',
  },
  resume: { id: 'composerCommands.resume', defaultMessage: 'Resume goal' },
  resumeHint: {
    id: 'composerCommands.resumeHint',
    defaultMessage: 'Continue the saved goal from its current progress',
  },
  status: { id: 'composerCommands.status', defaultMessage: 'View goal' },
  statusHint: {
    id: 'composerCommands.statusHint',
    defaultMessage: 'Show the saved objective, state and continuation limit',
  },
  plan: { id: 'composerCommands.plan', defaultMessage: 'Plan' },
  planHint: {
    id: 'composerCommands.planHint',
    defaultMessage: 'Plan and review the task before implementation',
  },
  planOff: { id: 'composerCommands.planOff', defaultMessage: 'Leave plan mode' },
  planOffHint: {
    id: 'composerCommands.planOffHint',
    defaultMessage: 'Return to normal collaboration; keep the approval setting',
  },
  compact: { id: 'composerCommands.compact', defaultMessage: 'Compact context' },
  compactHint: {
    id: 'composerCommands.compactHint',
    defaultMessage: 'Summarize the current conversation context',
  },
  goalUsage: {
    id: 'composerCommands.goalUsage',
    defaultMessage:
      'Type /goal followed by your objective and acceptance criteria. The agent continues automatically and uses model credits; you can pause at any time.',
  },
  planUsage: {
    id: 'composerCommands.planUsage',
    defaultMessage: 'Type /plan followed by the task you want to plan.',
  },
  noSession: {
    id: 'composerCommands.noSession',
    defaultMessage: 'Open a conversation to use this command.',
  },
  noGoal: {
    id: 'composerCommands.noGoal',
    defaultMessage: 'This conversation has no saved goal. Use /goal followed by your objective.',
  },
  busy: {
    id: 'composerCommands.busy',
    defaultMessage: 'Wait for the current turn to finish, or pause the goal first.',
  },
  paused: {
    id: 'composerCommands.paused',
    defaultMessage: 'Goal paused. Use /goal resume to continue.',
  },
  cannotResume: {
    id: 'composerCommands.cannotResume',
    defaultMessage:
      'This goal is complete or has reached its continuation limit. Review its results before starting a new goal.',
  },
  resumePrompt: {
    id: 'composerCommands.resumePrompt',
    defaultMessage:
      'Continue the saved long-term goal from its current progress. Verify remaining work without repeating completed external actions.',
  },
  planOn: {
    id: 'composerCommands.planOn',
    defaultMessage: 'Plan mode selected. Describe the task in the input below.',
  },
  planOffDone: {
    id: 'composerCommands.planOffDone',
    defaultMessage: 'Normal collaboration selected.',
  },
  queued: {
    id: 'composerCommands.queued',
    defaultMessage: 'The mode change will apply at the next model step.',
  },
  statusText: {
    id: 'composerCommands.statusText',
    defaultMessage: '{objective}\n{state} · {used}/{limit} continuation rounds',
  },
  active: { id: 'composerCommands.active', defaultMessage: 'Active' },
  disarmed: { id: 'composerCommands.disarmed', defaultMessage: 'Ready to resume' },
  blocked: { id: 'composerCommands.blocked', defaultMessage: 'Needs attention' },
  complete: {
    id: 'composerCommands.complete',
    defaultMessage: 'Marked complete; review the results',
  },
  pausedState: { id: 'composerCommands.pausedState', defaultMessage: 'Paused' },
  failure: {
    id: 'composerCommands.failure',
    defaultMessage:
      'The command did not complete. Your input is preserved; check the connection and try again.',
  },
});

// Explicit slash grammar only. Ordinary user prose is never classified here.
export function parseComposerCommand(text: string) {
  const match = /^\/(goal|plan)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const argument = (match[2] ?? '').trim();
  return { name: match[1] as 'goal' | 'plan', argument };
}

export function isComposerControl(text: string): boolean {
  const command = parseComposerCommand(text);
  return (
    !!command &&
    (command.name === 'goal'
      ? ['', 'pause', 'resume', 'status', 'clear', 'edit'].includes(command.argument) ||
        command.argument.startsWith('edit ')
      : ['', 'on', 'off'].includes(command.argument))
  );
}

export function composerCommandItems(intl: IntlShape): DisplayItem[] {
  const entries = [
    ['file', 'file', 'fileHint'],
    ['agent', 'agent', 'agentHint'],
    ['goal', 'goal', 'goalHint'],
    ['plan', 'plan', 'planHint'],
    ['compact', 'compact', 'compactHint'],
    ['permission', 'permission', 'permissionHint'],
    ['model', 'model', 'modelHint'],
    ['export', 'export', 'exportHint'],
  ] as const;
  return entries.map(([command, title, hint], commandOrder) => ({
    name: intl.formatMessage(composerMessages[title]),
    extra: intl.formatMessage(composerMessages[hint]),
    itemType: 'Builtin',
    commandGroup: ['file', 'agent', 'goal', 'plan'].includes(command) ? 'add' : 'control',
    commandOrder,
    relativePath: command,
    insertText: `/${command} `,
  }));
}

export function parseComposerUiCommand(text: string) {
  const match = /^\/(file|agent|permission|model|export)\s*$/.exec(text.trim());
  return match?.[1] as 'file' | 'agent' | 'permission' | 'model' | 'export' | undefined;
}

export async function prepareComposerCommand(
  input: UserInput,
  sessionId: string | null,
  busy: boolean,
  intl: IntlShape
): Promise<{ input?: UserInput; notice?: string }> {
  const command = parseComposerCommand(input.msg);
  if (!command) return { input };
  const say = (key: keyof typeof composerMessages) => ({
    notice: intl.formatMessage(composerMessages[key]),
  });
  const { name, argument } = command;
  if (
    name === 'goal' &&
    !['', 'pause', 'resume', 'status', 'clear', 'edit'].includes(argument) &&
    !argument.startsWith('edit ')
  ) {
    if (busy) return say('busy');
    if (argument.length > 16000) return say('goalUsage');
    return {
      input: {
        ...input,
        msg: argument,
        goalRequest: { action: 'create', objective: argument },
      },
    };
  }
  if (name === 'plan' && !['', 'on', 'off'].includes(argument)) {
    if (busy) return say('busy');
    return { input: { ...input, msg: argument, planMode: true } };
  }
  if (name === 'goal' && !argument) return say('goalUsage');
  if (!sessionId) return say(name === 'plan' && argument !== 'off' ? 'planUsage' : 'noSession');
  if (name === 'plan') {
    const plan = await setSessionPlanMode(sessionId, argument !== 'off');
    return say(plan.pending ? 'queued' : plan.active ? 'planOn' : 'planOffDone');
  }
  const goal = await getSessionGoal(sessionId);
  if (!goal) return say('noGoal');
  if (argument === 'edit') return say('editUsage');
  if (argument.startsWith('edit ')) {
    const objective = argument.slice(5).trim();
    if (!objective || objective.length > 16000) return say('editUsage');
    await changeSessionGoal(sessionId, goal, 'edit', objective);
    return say('edited');
  }
  if (argument === 'clear') {
    await changeSessionGoal(sessionId, goal, 'clear');
    return say('cleared');
  }
  if (argument === 'pause') {
    await pauseSessionGoal(sessionId, goal);
    return say('paused');
  }
  if (argument === 'resume') {
    if (busy) return say('busy');
    if (goal.phase === 'complete' || goal.roundsStarted >= goal.maxGoalRounds)
      return say('cannotResume');
    return {
      input: {
        ...input,
        msg: intl.formatMessage(composerMessages.resumePrompt),
        goalRequest: { action: 'resume', goalId: goal.id, revision: goal.revision },
      },
    };
  }
  const state =
    goal.phase === 'active' && goal.activation === 'disarmed'
      ? 'disarmed'
      : goal.phase === 'paused'
        ? 'pausedState'
        : goal.phase;
  return {
    notice:
      intl.formatMessage(composerMessages.statusText, {
        objective: goal.objective,
        state: intl.formatMessage(composerMessages[state]),
        used: goal.roundsStarted,
        limit: goal.maxGoalRounds,
      }) + (goal.blockedReason ? `\n${goal.blockedReason.message}` : ''),
  };
}

export function composerCommandFailure(intl: IntlShape) {
  return intl.formatMessage(composerMessages.failure);
}
