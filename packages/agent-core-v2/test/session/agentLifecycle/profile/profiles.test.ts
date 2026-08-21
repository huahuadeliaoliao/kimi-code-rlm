import { describe, expect, it } from 'vitest';

import { getAgentProfileContributions } from '#/app/agentProfileCatalog/contribution';
import '#/session/agentLifecycle/profile/profiles';

function profile(name: string) {
  const found = getAgentProfileContributions().find((candidate) => candidate.name === name);
  expect(found, `builtin profile "${name}" is registered`).toBeDefined();
  return found!;
}

describe('builtin agent profiles', () => {
  it('keeps the default RLM profile single-agent and free of direct execution tools', () => {
    const agent = profile('agent');
    expect(agent.tools).toEqual([
      'RlmKernel',
      'ReadMediaFile',
      'Skill',
      'FetchURL',
      'CreateGoal',
      'GetGoal',
      'UpdateGoal',
      'mcp__*',
    ]);
    expect(agent.subagents).toBeUndefined();
  });

  it('keeps the RLM system prompt single-role and stable across transient environment facts', () => {
    const agent = profile('agent');
    const common = {
      cwd: '/work',
      osKind: 'macOS',
      shellName: 'bash',
      shellPath: '/bin/bash',
      agentsMd: 'PROJECT_RULES',
      skills: 'SKILL_LIST',
      additionalDirs: ['/extra'],
    };
    const first = agent.systemPrompt({
      ...common,
      now: '2026-01-01T00:00:00.000Z',
      cwdListing: 'old-file.ts',
      additionalDirsInfo: '### /extra\nold-extra.ts',
    });
    const second = agent.systemPrompt({
      ...common,
      now: '2026-08-20T12:34:56.000Z',
      cwdListing: 'new-file.ts',
      additionalDirsInfo: '### /extra\nnew-extra.ts',
    });

    expect(first).toBe(second);
    expect(first).toContain('/extra');
    expect(first).toContain('PROJECT_RULES');
    expect(first).toContain('SKILL_LIST');
    expect(first).not.toMatch(/old-file|new-file|old-extra|new-extra|session-start timestamp/i);
    expect(first).not.toMatch(
      /TodoList|CronCreate|CronList|CronDelete|self-audit|Completion audit|Blocked audit|next concrete phase|progress notes/i,
    );
    expect(first.match(/RlmKernel/g)).toHaveLength(1);
  });

  it('renders only live workspace paths and no stock-tool dialect on edge contexts', () => {
    const agent = profile('agent');
    const prompt = agent.systemPrompt({
      cwd: 'C:\\work tree',
      osKind: 'Windows',
      shellName: 'bash',
      shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
      cwdListing: '.env\nmissing-from-cache.ts',
      additionalDirs: ['C:\\shared tree'],
      additionalDirsInfo: '### C:\\shared tree\nstale-child.ts',
      agentsMd: '',
      skills: 'SHOULD_NOT_RENDER',
      skillActive: false,
    });

    expect(prompt).toContain('C:\\work tree');
    expect(prompt).toContain('C:\\shared tree');
    expect(prompt).not.toMatch(/missing-from-cache|stale-child|SHOULD_NOT_RENDER/);
    expect(prompt).not.toMatch(/Bash tool|Read, Write, Edit, Glob, Grep/);
    expect(prompt).not.toContain('# Project Instructions');
    expect(prompt).not.toContain('# Skills');
  });
});
