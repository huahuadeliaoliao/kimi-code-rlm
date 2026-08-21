import type { GoalSnapshot } from '#/agent/goal/types';
import { Service } from "#/_base/di/service";
import { renderPrompt } from "#/_base/utils/render-prompt";
import {
  IAgentContextInjectorService,
  type ContextInjectionResult,
} from '#/agent/contextInjector/contextInjector';
import GOAL_ACTIVE_REMINDER from './goal-active-reminder.md?raw';
import GOAL_BLOCKED_REMINDER from './goal-blocked-reminder.md?raw';
import GOAL_PAUSED_REMINDER from './goal-paused-reminder.md?raw';

export interface GoalInjectionOptions {
  readonly getGoal: () => GoalSnapshot | null;
  readonly isWaitForEnabled?: () => boolean;
  readonly isSetGoalBudgetEnabled?: () => boolean;
}

export interface GoalInjectionDisclosure {
  readonly goalId: string;
  readonly status: GoalSnapshot['status'];
}

export const GOAL_WAIT_FOR_GUIDANCE =
  'If you are waiting for background sub-agents or bash tasks to finish, call WaitFor inside this turn rather than stopping for another continuation. You may do other useful work while waiting.';

export class GoalInjection extends Service {
  constructor(
    private readonly options: GoalInjectionOptions,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
  ) {
    super();
    this._register(
      injector.register<GoalInjectionDisclosure>('goal', ({ isNewTurn }) =>
        isNewTurn ? this.reminder() : undefined,
      ),
    );
  }

  private reminder(): ContextInjectionResult<GoalInjectionDisclosure> | undefined {
    const goal = this.options.getGoal();
    if (goal === null) return undefined;
    let content: string | undefined;
    if (goal.status === 'active') {
      content = buildGoalReminder(
        goal,
        this.options.isWaitForEnabled?.() === true,
        this.options.isSetGoalBudgetEnabled?.() === true,
      );
    } else if (goal.status === 'blocked') {
      content = buildBlockedNote(goal);
    } else if (goal.status === 'paused') {
      content = buildPausedNote(goal);
    }
    if (content === undefined) return undefined;
    return {
      content,
      disclosure: { goalId: goal.goalId, status: goal.status },
    };
  }
}

const BUDGET_GUIDANCE_NEARING =
  'A hard budget is nearing its limit. Prioritize required completion criteria and avoid optional scope.';

function buildBlockedNote(goal: GoalSnapshot): string {
  return renderPrompt(GOAL_BLOCKED_REMINDER, {
    reason_suffix: reasonSuffix(goal),
    objective: escapeUntrustedText(goal.objective),
    completion_criterion_block: completionCriterionBlock(goal),
  });
}

function buildPausedNote(goal: GoalSnapshot): string {
  return renderPrompt(GOAL_PAUSED_REMINDER, {
    reason_suffix: reasonSuffix(goal),
    objective: escapeUntrustedText(goal.objective),
    completion_criterion_block: completionCriterionBlock(goal),
  });
}

function buildGoalReminder(
  goal: GoalSnapshot,
  waitForEnabled: boolean,
  setGoalBudgetEnabled: boolean,
): string {
  const budgets = formatBudgets(goal);
  return renderPrompt(GOAL_ACTIVE_REMINDER, {
    objective: escapeUntrustedText(goal.objective),
    completion_criterion_block: completionCriterionBlock(goal),
    budgets_block: budgets.length > 0 ? `Budgets: ${budgets}.\n` : '',
    budget_guidance:
      budgets.length > 0 && isNearingBudget(goal) ? `${BUDGET_GUIDANCE_NEARING}\n` : '',
    budget_update_guidance: setGoalBudgetEnabled
      ? 'If the objective or latest request states a clear hard limit that is not already recorded, call SetGoalBudget before further goal work. Do not invent a limit.\n'
      : '',
    wait_for_guidance: waitForEnabled ? ` ${GOAL_WAIT_FOR_GUIDANCE}` : '',
  });
}

function reasonSuffix(goal: GoalSnapshot): string {
  const reason = goal.terminalReason;
  return reason === undefined ? '' : ` (${escapeUntrustedText(reason)})`;
}

function completionCriterionBlock(goal: GoalSnapshot): string {
  if (goal.completionCriterion === undefined) return '';
  return `<untrusted_completion_criterion>\n${escapeUntrustedText(goal.completionCriterion)}\n</untrusted_completion_criterion>\n`;
}

function formatBudgets(goal: GoalSnapshot): string {
  const budgetLines: string[] = [];
  if (goal.budget.turnBudget !== null) {
    budgetLines.push(
      `turns ${goal.turnsUsed}/${goal.budget.turnBudget} (remaining ${goal.budget.remainingTurns})`,
    );
  }
  if (goal.budget.tokenBudget !== null) {
    budgetLines.push(
      `tokens ${goal.tokensUsed}/${goal.budget.tokenBudget} (remaining ${goal.budget.remainingTokens})`,
    );
  }
  if (goal.budget.wallClockBudgetMs !== null) {
    budgetLines.push(
      `time ${formatElapsed(goal.wallClockMs)}/${formatElapsed(goal.budget.wallClockBudgetMs)} (remaining ${formatElapsed(goal.budget.remainingWallClockMs ?? 0)})`,
    );
  }
  return budgetLines.join('; ');
}

function isNearingBudget(goal: GoalSnapshot): boolean {
  return maxBudgetFraction(goal) >= 0.75;
}

function maxBudgetFraction(goal: GoalSnapshot): number {
  const fractions: number[] = [];
  if (goal.budget.turnBudget !== null && goal.budget.turnBudget > 0) {
    fractions.push(goal.turnsUsed / goal.budget.turnBudget);
  }
  if (goal.budget.tokenBudget !== null && goal.budget.tokenBudget > 0) {
    fractions.push(goal.tokensUsed / goal.budget.tokenBudget);
  }
  if (goal.budget.wallClockBudgetMs !== null && goal.budget.wallClockBudgetMs > 0) {
    fractions.push(goal.wallClockMs / goal.budget.wallClockBudgetMs);
  }
  return fractions.length === 0 ? 0 : Math.max(...fractions);
}

function escapeUntrustedText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${(minutes % 60).toString().padStart(2, '0')}m`;
}
