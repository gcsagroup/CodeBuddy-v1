import { describe, it, expect } from 'vitest';
import {
  detectInterruption,
  isInterruptionCommand,
  getInterruptionMessage,
  INTERRUPTION_KEYWORDS,
  InterruptionMatch,
} from './interruptionDetector';

describe('interruptionDetector', () => {
  describe('explicit commands and ordinary queued messages', () => {
    it.each([
      '停止',
      '取消',
      '停止当前任务',
      '取消这个任务',
      '停止执行',
      '请停止',
      '请停止当前任务',
      '暂停',
      '暂停一下',
      '先停一下',
      '停止！',
      '取消。',
      '停一下，改成草稿',
      '请停止当前任务，然后等我确认',
      'stop!',
      '停止\n改成草稿',
      'please stop',
      'cancel this task',
      'stop writing',
      'stop processing',
      'pause execution',
      'cancel the task',
      'stop the current task',
    ])('interrupts an explicit control request: %s', (input) => {
      expect(detectInterruption(input)?.shouldInterrupt).toBe(true);
    });

    it.each([
      'weekend',
      'unstoppable',
      'send',
      'holding',
      'no tools needed',
      'stop button',
      'stop.ts',
      'cancel.json',
      'stop sign',
      'stop file',
      'stop processing time',
      'cancel button',
      'cancel the task button',
      'cancel the task.md',
      'cancel the task means cancelling work',
      'cancel the task 是什么意思',
      'explain cancel the task',
      'wait time',
      '引用：stop',
      '解释“cancel”',
      '"stop"',
      '“停止”',
      '「取消」',
      '`cancel`',
      '```\nstop\n```',
      '> stop',
      'please explain "stop"',
      '不要停止',
      '不要停止，继续',
      '解释停止是什么意思',
      '不要取消当前任务',
      '请不要停止',
      'do not stop',
      "don't cancel",
      '停止按钮是什么',
      '取消操作的教程',
      '继续',
      '继续。',
      '给标题加上 stop 这个词',
    ])('keeps ordinary or quoted content in the queue: %s', (input) => {
      expect(detectInterruption(input)).toBeNull();
    });
  });

  describe('detectInterruption', () => {
    describe('exact matches (confidence: 1.0)', () => {
      it('detects exact stop variations', () => {
        const result = detectInterruption('stop');
        expect(result).not.toBeNull();
        expect(result?.confidence).toBe(1.0);
        expect(result?.keyword.action).toBe('stop');
        expect(result?.shouldInterrupt).toBe(true);
      });

      it('detects exact wait variations', () => {
        const result = detectInterruption('pause');
        expect(result).not.toBeNull();
        expect(result?.confidence).toBe(1.0);
        expect(result?.keyword.action).toBe('pause');
        expect(result?.shouldInterrupt).toBe(true);
      });

      it('detects exact redirect variations', () => {
        const result = detectInterruption('actually');
        expect(result).not.toBeNull();
        expect(result?.confidence).toBe(1.0);
        expect(result?.keyword.action).toBe('redirect');
        expect(result?.shouldInterrupt).toBe(true);
      });

      it('is case-insensitive', () => {
        expect(detectInterruption('STOP')?.confidence).toBe(1.0);
        expect(detectInterruption('Stop')?.confidence).toBe(1.0);
        expect(detectInterruption('sToP')?.confidence).toBe(1.0);
      });
    });

    describe('beginning matches (confidence: 0.9)', () => {
      it('detects variations at start with space', () => {
        const result = detectInterruption('stop doing that');
        expect(result).not.toBeNull();
        expect(result?.confidence).toBe(0.9);
        expect(result?.shouldInterrupt).toBe(true);
      });

      it('detects variations at start with comma', () => {
        const result = detectInterruption('wait, I need to think');
        expect(result).not.toBeNull();
        expect(result?.confidence).toBe(0.9);
        expect(result?.shouldInterrupt).toBe(true);
      });

      it('detects "never mind" at the beginning', () => {
        const result = detectInterruption('never mind, forget it');
        expect(result).not.toBeNull();
        expect(result?.confidence).toBe(0.9);
        expect(result?.keyword.action).toBe('stop');
      });
    });

    describe('contained matches in short inputs (confidence: 0.7)', () => {
      it('detects keywords in short messages', () => {
        const result = detectInterruption('oh wait please');
        expect(result).not.toBeNull();
        expect(result?.confidence).toBe(0.7);
        expect(result?.matchedText).toBe('wait');
      });

      it('only interrupts high priority keywords when confidence is 0.7', () => {
        // High priority - should interrupt
        const highPriority = detectInterruption('oh stop please');
        expect(highPriority?.shouldInterrupt).toBe(true);

        // Medium priority - should not interrupt at 0.7 confidence
        // Note: "oh actually wait" will match "wait" (high priority) first, so let's use a different example
        const mediumPriority = detectInterruption('oh actually');
        expect(mediumPriority?.confidence).toBe(0.7);
        expect(mediumPriority?.shouldInterrupt).toBe(false);
      });

      it('does not treat a word substring as a command', () => {
        const result = detectInterruption('unstoppable');
        expect(result).toBeNull();

        // Words that don't contain any keyword variations should return null
        expect(detectInterruption('continuing')).toBeNull();
        expect(detectInterruption('proceeding')).toBeNull();

        // Long messages should not match even if they contain keywords
        expect(
          detectInterruption('this is a very long message with stop in it somewhere')
        ).toBeNull();
      });

      it('ignores keywords in long messages', () => {
        const longMessage =
          'This is a very long message that contains stop but should not be detected';
        expect(detectInterruption(longMessage)).toBeNull();
      });
    });

    describe('edge cases', () => {
      it('does not infer a command from an ordinary word', () => {
        const result = detectInterruption('unstoppable');
        expect(result).toBeNull();

        // Words that don't contain any keyword variations should return null
        expect(detectInterruption('continuing')).toBeNull();
        expect(detectInterruption('proceeding')).toBeNull();

        // Long messages should not match even if they contain keywords
        expect(
          detectInterruption('this is a very long message with stop in it somewhere')
        ).toBeNull();
      });

      it('handles multiple keyword matches by returning first match', () => {
        const result = detectInterruption('stop wait');
        expect(result?.matchedText).toBe('stop');
        expect(result?.confidence).toBe(0.9);
      });
    });
  });

  describe('isInterruptionCommand', () => {
    it('returns true for interruption commands', () => {
      expect(isInterruptionCommand('stop')).toBe(true);
      expect(isInterruptionCommand('wait')).toBe(true);
      expect(isInterruptionCommand('halt now')).toBe(true);
    });

    it('returns false for non-interruption text', () => {
      expect(isInterruptionCommand('continue')).toBe(false);
      expect(isInterruptionCommand('hello')).toBe(false);
      expect(isInterruptionCommand('')).toBe(false);
    });

    it('respects shouldInterrupt flag', () => {
      // Medium priority keyword in short text - shouldInterrupt is false
      expect(isInterruptionCommand('oh actually')).toBe(false);

      // High priority keyword in short text - shouldInterrupt is true
      expect(isInterruptionCommand('oh stop')).toBe(true);
    });
  });

  describe('getInterruptionMessage', () => {
    it('returns correct message for stop action', () => {
      const match: InterruptionMatch = {
        keyword: INTERRUPTION_KEYWORDS.find((k) => k.action === 'stop')!,
        matchedText: 'stop',
        confidence: 1.0,
        shouldInterrupt: true,
      };
      expect(getInterruptionMessage(match)).toBe('Stopped processing. You said "stop".');
    });

    it('returns correct message for pause action', () => {
      const match: InterruptionMatch = {
        keyword: INTERRUPTION_KEYWORDS.find((k) => k.action === 'pause')!,
        matchedText: 'wait',
        confidence: 1.0,
        shouldInterrupt: true,
      };
      expect(getInterruptionMessage(match)).toBe('Paused processing. You said "wait".');
    });

    it('returns correct message for redirect action', () => {
      const match: InterruptionMatch = {
        keyword: INTERRUPTION_KEYWORDS.find((k) => k.action === 'redirect')!,
        matchedText: 'actually',
        confidence: 1.0,
        shouldInterrupt: true,
      };
      expect(getInterruptionMessage(match)).toBe('Stopping to redirect. You said "actually".');
    });

    it('returns default message for unknown action', () => {
      const match: InterruptionMatch = {
        keyword: {
          keyword: 'test',
          variations: ['test'],
          priority: 'low',
          action: 'unknown' as 'stop',
        },
        matchedText: 'test',
        confidence: 1.0,
        shouldInterrupt: true,
      };
      expect(getInterruptionMessage(match)).toBe('Interrupted processing. You said "test".');
    });
  });

  describe('INTERRUPTION_KEYWORDS', () => {
    it('has valid structure for all keywords', () => {
      INTERRUPTION_KEYWORDS.forEach((keyword) => {
        expect(keyword.keyword).toBeTruthy();
        expect(keyword.variations).toBeInstanceOf(Array);
        expect(keyword.variations.length).toBeGreaterThan(0);
        expect(['high', 'medium', 'low']).toContain(keyword.priority);
        expect(['stop', 'pause', 'redirect']).toContain(keyword.action);
      });
    });

    it('includes the main keyword in variations', () => {
      INTERRUPTION_KEYWORDS.forEach((keyword) => {
        expect(keyword.variations).toContain(keyword.keyword);
      });
    });
  });
});
