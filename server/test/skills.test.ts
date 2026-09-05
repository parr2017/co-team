import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// capture system prompts to prove skill bodies reach the agent
const seenSystems: string[] = [];
vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (_entry: any, messages: { role: string; content: string }[]) => {
      const sys = [...messages].reverse().find((m) => m.role === 'system')?.content || '';
      seenSystems.push(sys);
      return {
        content: JSON.stringify({ status: 'success', summary: 'done', changes: [], errors: [], verification: '核对完成' }),
        promptTokens: 3,
        completionTokens: 4,
      };
    },
  };
});

import { initBus, closeBus } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { saveTaskGraph, getTaskGraph } from '../src/store';
import { reloadSkills, getSkills, pickSkillsForNode, writeSkill, deleteSkill } from '../src/skills';
import type { TaskGraph, TaskNode } from '../src/types';

let tmp: string;
let globalDir: string;

function skillMd(name: string, description: string, tags: string[], body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\ntags: [${tags.join(', ')}]\n---\n\n${body}\n`;
}

beforeEach(() => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-skill-'));
  globalDir = path.join(tmp, 'skills');
  fs.mkdirSync(globalDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
});

describe('skills discovery & parsing', () => {
  it('parses SKILL.md frontmatter and body; missing tags default to empty', () => {
    fs.mkdirSync(path.join(globalDir, 'feishu'), { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'feishu', 'SKILL.md'), skillMd('feishu', '飞书接入规范', ['docs'], '1. 创建应用\n2. 配置回调'));
    fs.mkdirSync(path.join(globalDir, 'notags'), { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'notags', 'SKILL.md'), '---\nname: notags\ndescription: 无标签技能\n---\n\n正文');
    const skills = reloadSkills(path.join(tmp, 'agents'), globalDir);
    expect(skills).toHaveLength(2);
    const feishu = skills.find((s) => s.name === 'feishu')!;
    expect(feishu.tags).toEqual(['docs']);
    expect(feishu.source).toBe('global');
    expect(feishu.body).toContain('配置回调');
    expect(skills.find((s) => s.name === 'notags')!.tags).toEqual([]);
  });

  it('discovers agent-private skills with the agent as source', () => {
    const agentsDir = path.join(tmp, 'agents');
    fs.mkdirSync(path.join(agentsDir, 'dev', 'skills', 'dev-only'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'dev', 'skills', 'dev-only', 'SKILL.md'), skillMd('dev-only', 'dev 专属', [], 'dev 秘籍'));
    const skills = reloadSkills(agentsDir, globalDir);
    const priv = skills.find((s) => s.name === 'dev-only')!;
    expect(priv.source).toBe('dev');
  });

  it('writeSkill + deleteSkill manage the global library on disk', () => {
    writeSkill(globalDir, { name: 'My Skill', description: 'd', tags: ['dev'], content: 'body text' });
    expect(fs.existsSync(path.join(globalDir, 'my-skill', 'SKILL.md'))).toBe(true);
    const skills = reloadSkills(path.join(tmp, 'agents'), globalDir);
    expect(skills.find((s) => s.name === 'my-skill')).toBeTruthy();
    expect(deleteSkill(globalDir, 'my-skill')).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'my-skill'))).toBe(false);
  });
});

describe('pickSkillsForNode matching strategy', () => {
  const lib = [
    { name: 'review-checklist', description: '审查清单', tags: ['review'], source: 'global', dir: '', body: 'REVIEW_BODY' },
    { name: 'test-craft', description: '测试设计', tags: ['test'], source: 'global', dir: '', body: 'TEST_BODY' },
    { name: 'dev-secret', description: 'dev 专属秘籍', tags: ['code'], source: 'dev', dir: '', body: 'SECRET_BODY' },
    { name: 'unrelated', description: '完全无关的技能', tags: [], source: 'global', dir: '', body: 'NOISE' },
  ];

  it('bound skills always ride with full body, regardless of tags', () => {
    const picks = pickSkillsForNode(lib, { name: 'dev', tags: ['code'], skills: ['unrelated'] }, '随便什么节点');
    // bound rides first, then auto-matched extras (dev-secret via tags) still apply
    expect(picks.map((p) => p.skill.name)).toEqual(['unrelated', 'dev-secret']);
    expect(picks[0].reason).toBe('bound');
  });

  it('agent-private skills are visible only to their own agent', () => {
    expect(pickSkillsForNode(lib, { name: 'dev', tags: ['code'], skills: [] }, '实现功能').map((p) => p.skill.name)).toContain('dev-secret');
    expect(pickSkillsForNode(lib, { name: 'review', tags: ['review'], skills: [] }, '审查代码').map((p) => p.skill.name)).not.toContain('dev-secret');
  });

  it('auto-matches by tags intersection, capped at 2', () => {
    const picks = pickSkillsForNode(lib, { name: 'review', tags: ['review', 'test'], skills: [] }, '普通节点');
    // review-checklist by tags; test-craft by tags; unrelated skipped → cap 2
    expect(picks.map((p) => p.skill.name)).toEqual(['review-checklist', 'test-craft']);
    expect(picks.every((p) => p.reason === 'tags')).toBe(true);
  });

  it('auto-matches by keyword overlap between node name and skill name/description', () => {
    const picks = pickSkillsForNode(lib, { name: 'dev', tags: ['code'], skills: [] }, '编写测试设计文档');
    // '测试设计' bigrams overlap test-craft's description; unrelated has no overlap
    expect(picks.map((p) => p.skill.name)).toContain('test-craft');
    expect(picks.map((p) => p.skill.name)).not.toContain('unrelated');
  });
});

describe('skill injection into the agent prompt (real callAgent via runGraph)', () => {
  beforeEach(() => {
    const agentsDir = path.join(tmp, 'agents');
    fs.mkdirSync(path.join(agentsDir, 'dev'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'dev', 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\nskills: [bound-skill-x]\n');
    fs.mkdirSync(path.join(globalDir, 'bound-skill-x'), { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'bound-skill-x', 'SKILL.md'), skillMd('bound-skill-x', '绑定技能', [], 'BOUND_SKILL_BODY_X'));
  });

  function makeOrchestrator(): Orchestrator {
    const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
    return new Orchestrator({
      agentsDir: path.join(tmp, 'agents'), modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
      maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
      skillsGlobalDir: globalDir,
    });
  }

  function makeNode(id: string, agent: string): TaskNode {
    return {
      id, task_id: 't', name: id, status: 'pending', agent, result: null, error: '',
      retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
      created_at: '', updated_at: '',
    };
  }

  it('bound skill body appears in the agent system prompt', async () => {
    seenSystems.length = 0;
    closeBus();
    await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
    const orch = makeOrchestrator();
    await orch.loadAgents(); // triggers reloadSkills

    await saveTaskGraph('t-skill', [makeNode('n1', 'dev')], [], { description: 'x', workspace: tmp, status: 'running' });
    const graph = (await getTaskGraph('t-skill')) as TaskGraph;
    await (orch as any).runGraph('t-skill', graph, tmp);

    expect(seenSystems.length).toBeGreaterThan(0);
    expect(seenSystems[0]).toContain('已装载技能');
    expect(seenSystems[0]).toContain('BOUND_SKILL_BODY_X');
  });
});
