/**
 * Utility for detecting interruption keywords in user input
 */

interface InterruptionKeyword {
  keyword: string;
  variations: string[];
  priority: 'high' | 'medium' | 'low';
  action: 'stop' | 'pause' | 'redirect';
}

// Define interruption keywords and their variations
export const INTERRUPTION_KEYWORDS: InterruptionKeyword[] = [
  {
    keyword: 'stop',
    variations: [
      'stop',
      'halt',
      'cease',
      'quit',
      'end',
      'abort',
      'cancel',
      '停止',
      '停止执行',
      '停止任务',
      '停止当前任务',
      '停止这个任务',
      '取消',
      '取消执行',
      '取消任务',
      '取消当前任务',
      '取消这个任务',
    ],
    priority: 'high',
    action: 'stop',
  },
  {
    keyword: 'wait',
    variations: [
      'wait',
      'hold',
      'pause',
      'hold on',
      'wait up',
      'hold up',
      '暂停',
      '暂停一下',
      '停一下',
      '先停一下',
      '等一下',
    ],
    priority: 'high',
    action: 'pause',
  },
  {
    keyword: 'no',
    variations: ['no', 'nope', 'nah', 'wrong', 'incorrect', 'not right'],
    priority: 'medium',
    action: 'stop',
  },
  {
    keyword: 'actually',
    variations: ['actually', 'instead', 'rather', 'better idea', 'change of plans'],
    priority: 'medium',
    action: 'redirect',
  },
  {
    keyword: 'nevermind',
    variations: ['nevermind', 'never mind', 'forget it', 'ignore that', 'disregard'],
    priority: 'medium',
    action: 'stop',
  },
];

export interface InterruptionMatch {
  keyword: InterruptionKeyword;
  matchedText: string;
  confidence: number;
  shouldInterrupt: boolean;
}

/**
 * Analyzes input text for interruption keywords
 */
export function detectInterruption(input: string): InterruptionMatch | null {
  if (!input || input.trim().length === 0) {
    return null;
  }

  const normalizedInput = input.toLowerCase().trim();
  const preface = normalizedInput.match(/^(please\s+|oh\s+|请)/)?.[0] ?? '';
  const command = normalizedInput.slice(preface.length).trim();

  // Keep the command anchored: quoted text and ordinary prose must remain queued.
  for (const keyword of INTERRUPTION_KEYWORDS) {
    for (const variation of keyword.variations) {
      if (!command.startsWith(variation)) continue;
      const remainder = command.slice(variation.length);
      const explicitContinuation = /^[,，!！。;；\n]|^\.(?:\s|$)/.test(
        remainder.replace(/^[ \t]+/, '')
      );
      const englishCommandTarget =
        keyword.priority === 'high' &&
        /^[a-z ]+$/.test(variation) &&
        (/^\s+(?:please|now|doing|using|sending|working|this|that|wait|the current|for me|for my)(?:\s|[,!.;]|$)/.test(
          remainder
        ) ||
          /^\s+(?:writing|processing|execution|the task)(?:\s+(?:now|please))?(?:[,!;]|\.(?:\s|$)|$)/.test(
            remainder
          ));
      if (remainder && !explicitContinuation && !englishCommandTarget) continue;

      const confidence = /^oh\s/.test(preface) ? 0.7 : !preface && !remainder ? 1.0 : 0.9;
      return {
        keyword,
        matchedText: variation,
        confidence,
        shouldInterrupt: confidence > 0.7 || keyword.priority === 'high',
      };
    }
  }

  return null;
}

/**
 * Checks if input is likely an interruption command
 */
export function isInterruptionCommand(input: string): boolean {
  const match = detectInterruption(input);
  return match?.shouldInterrupt ?? false;
}

/**
 * Gets a user-friendly message for the interruption action
 */
export function getInterruptionMessage(match: InterruptionMatch): string {
  switch (match.keyword.action) {
    case 'stop':
      return `Stopped processing. You said "${match.matchedText}".`;
    case 'pause':
      return `Paused processing. You said "${match.matchedText}".`;
    case 'redirect':
      return `Stopping to redirect. You said "${match.matchedText}".`;
    default:
      return `Interrupted processing. You said "${match.matchedText}".`;
  }
}
