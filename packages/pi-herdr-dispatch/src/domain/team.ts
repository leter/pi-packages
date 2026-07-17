import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DispatchMode } from "../registry/types.js";

export interface Role {
  key: string;
  label: string;
  mode: DispatchMode;
  brief: string;
}

export interface WorkflowEscalation {
  afterCycles: number;
  role: string;
}

export interface Workflow {
  key: string;
  stages: readonly string[];
  maxReworkCycles: number;
  escalation: readonly WorkflowEscalation[];
}

export interface TeamCatalog {
  roles: Readonly<Record<string, Role>>;
  workflows: Readonly<Record<string, Workflow>>;
}

export type TeamConfigState =
  | { status: "ready"; team: TeamCatalog }
  | { status: "invalid"; reason: string };

const ROLE_KEY = /^[a-z][a-z0-9-]{0,39}$/u;
const ROLE_FIELDS = new Set(["label", "mode", "brief"]);
const WORKFLOW_FIELDS = new Set(["stages", "maxReworkCycles", "escalation"]);
const ESCALATION_FIELDS = new Set(["afterCycles", "role"]);
const TOP_LEVEL_FIELDS = new Set(["roles", "workflows"]);

export const DEFAULT_TEAM_CATALOG: TeamCatalog = freezeTeam({
  roles: {
    coder: {
      key: "coder",
      label: "\u5f00\u53d1",
      mode: "write",
      brief:
        "You are acting as the implementation specialist. Focus on a correct, maintainable change within the task's stated scope.",
    },
    reviewer: {
      key: "reviewer",
      label: "\u8bc4\u5ba1",
      mode: "non-mutating",
      brief:
        "You are acting as an independent reviewer. Inspect the work without mutating files and report concrete findings.",
    },
    bugfix: {
      key: "bugfix",
      label: "\u4feebug",
      mode: "write",
      brief:
        "You are acting as the bug-fix specialist. Use the available evidence to make the smallest robust correction within scope.",
    },
    chore: {
      key: "chore",
      label: "\u6742\u6d3b",
      mode: "write",
      brief:
        "You are acting as the maintenance specialist. Complete the bounded upkeep task carefully and keep unrelated changes out.",
    },
    researcher: {
      key: "researcher",
      label: "\u8d44\u6599",
      mode: "non-mutating",
      brief:
        "You are acting as the research specialist. Gather relevant evidence and distinguish verified facts from inference.",
    },
    advisor: {
      key: "advisor",
      label: "\u987e\u95ee",
      mode: "non-mutating",
      brief:
        "You are acting as a consulting specialist. Analyze the stated question and offer focused options without changing project files.",
    },
    oracle: {
      key: "oracle",
      label: "\u7ec8\u5ba1",
      mode: "non-mutating",
      brief:
        "You are acting as the final-review specialist. Resolve the exhausted escalation or verdict question from the supplied evidence.",
    },
  },
  workflows: {
    dev: {
      key: "dev",
      stages: ["coder", "reviewer"],
      maxReworkCycles: 2,
      escalation: [
        { afterCycles: 2, role: "bugfix" },
        { afterCycles: 4, role: "oracle" },
      ],
    },
    research: {
      key: "research",
      stages: ["researcher"],
      maxReworkCycles: 2,
      escalation: [],
    },
    quick: {
      key: "quick",
      stages: ["chore"],
      maxReworkCycles: 2,
      escalation: [],
    },
  },
});

export function defaultTeamConfigPath(home = homedir()): string {
  return join(home, ".config", "pi-herdr-dispatch", "team.json");
}

export async function loadTeamConfig(path = defaultTeamConfigPath()): Promise<TeamConfigState> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { status: "ready", team: cloneDefaultTeam() };
    return { status: "invalid", reason: errorMessage(error) };
  }
  try {
    return { status: "ready", team: parseTeamConfig(JSON.parse(text)) };
  } catch (error) {
    return { status: "invalid", reason: errorMessage(error) };
  }
}

export function parseTeamConfig(value: unknown): TeamCatalog {
  if (!isRecord(value)) throw new TypeError("team config must be a JSON object");
  rejectUnknownFields(value, TOP_LEVEL_FIELDS, "team config");
  const roleOverrides = optionalRecord(value.roles, "roles");
  const workflowOverrides = optionalRecord(value.workflows, "workflows");

  const roles: Record<string, Role> = Object.fromEntries(
    Object.entries(DEFAULT_TEAM_CATALOG.roles).map(([key, role]) => [key, { ...role }]),
  );
  for (const [key, role] of Object.entries(roleOverrides)) roles[key] = parseRole(key, role);

  const workflows: Record<string, Workflow> = Object.fromEntries(
    Object.entries(DEFAULT_TEAM_CATALOG.workflows).map(([key, workflow]) => [
      key,
      {
        ...workflow,
        stages: [...workflow.stages],
        escalation: workflow.escalation.map((entry) => ({ ...entry })),
      },
    ]),
  );
  for (const [key, workflow] of Object.entries(workflowOverrides)) {
    workflows[key] = parseWorkflow(key, workflow);
  }
  validateWorkflowReferences(workflows, roles);
  return freezeTeam({ roles, workflows });
}

export function defaultWorkflowForRole(role: string | undefined): string | undefined {
  if (role === "coder") return "dev";
  if (role === "researcher") return "research";
  if (role === "chore") return "quick";
  return undefined;
}

export function executorRoleForCycle(workflow: Workflow, cycles: number): string {
  assertCycle(cycles);
  let role = workflow.stages[0]!;
  for (const entry of workflow.escalation) {
    if (entry.afterCycles > cycles) break;
    role = entry.role;
  }
  return role;
}

export function isReworkExhausted(workflow: Workflow, cycles: number): boolean {
  assertCycle(cycles);
  const lastEscalation = workflow.escalation.at(-1);
  return lastEscalation === undefined
    ? cycles >= workflow.maxReworkCycles
    : cycles >= lastEscalation.afterCycles + workflow.maxReworkCycles;
}

export function taskStageInfo(
  task: { role?: string; workflow?: string; stageIndex: number; reworkCycles: number },
  team: TeamCatalog | undefined,
): { roleKey?: string; stageNumber: number; stageCount: number } {
  if (!task.workflow) {
    return {
      ...(task.role === undefined ? {} : { roleKey: task.role }),
      stageNumber: 1,
      stageCount: 1,
    };
  }
  const workflow = team?.workflows[task.workflow];
  if (!workflow) {
    return {
      ...(task.role === undefined ? {} : { roleKey: task.role }),
      stageNumber: task.stageIndex + 1,
      stageCount: Math.max(1, task.stageIndex + 1),
    };
  }
  const boundedIndex = Math.min(Math.max(0, task.stageIndex), workflow.stages.length - 1);
  return {
    roleKey: boundedIndex === 0
      ? executorRoleForCycle(workflow, task.reworkCycles)
      : workflow.stages[boundedIndex]!,
    stageNumber: boundedIndex + 1,
    stageCount: workflow.stages.length,
  };
}

function parseRole(key: string, value: unknown): Role {
  validateKey(key, "role");
  if (!isRecord(value)) throw new TypeError(`role ${key} must be an object`);
  rejectUnknownFields(value, ROLE_FIELDS, `role ${key}`);
  const label = boundedText(value.label, `role ${key} label`, 20);
  const brief = boundedText(value.brief, `role ${key} brief`, 400);
  if (value.mode !== "write" && value.mode !== "non-mutating") {
    throw new TypeError(`role ${key} mode must be write or non-mutating`);
  }
  return { key, label, mode: value.mode, brief };
}

function parseWorkflow(key: string, value: unknown): Workflow {
  validateKey(key, "workflow");
  if (!isRecord(value)) throw new TypeError(`workflow ${key} must be an object`);
  rejectUnknownFields(value, WORKFLOW_FIELDS, `workflow ${key}`);
  if (!Array.isArray(value.stages) || value.stages.length < 1 || value.stages.length > 20) {
    throw new RangeError(`workflow ${key} stages must contain from 1 to 20 role keys`);
  }
  const stages = value.stages.map((stage, index) => {
    if (typeof stage !== "string") throw new TypeError(`workflow ${key} stage ${index + 1} must be a role key`);
    validateKey(stage, `workflow ${key} stage`);
    return stage;
  });
  if (!Number.isSafeInteger(value.maxReworkCycles)) {
    throw new TypeError(`workflow ${key} maxReworkCycles must be an integer`);
  }
  const maxReworkCycles = value.maxReworkCycles as number;
  if (maxReworkCycles < 0 || maxReworkCycles > 10) {
    throw new RangeError(`workflow ${key} maxReworkCycles must be from 0 to 10`);
  }
  if (!Array.isArray(value.escalation)) {
    throw new TypeError(`workflow ${key} escalation must be an array`);
  }
  let previousCycles = 0;
  const escalation = value.escalation.map((entry, index) => {
    if (!isRecord(entry)) throw new TypeError(`workflow ${key} escalation ${index + 1} must be an object`);
    rejectUnknownFields(entry, ESCALATION_FIELDS, `workflow ${key} escalation ${index + 1}`);
    if (!Number.isSafeInteger(entry.afterCycles) || (entry.afterCycles as number) <= previousCycles) {
      throw new RangeError(`workflow ${key} escalation afterCycles must be strictly increasing positive integers`);
    }
    if (typeof entry.role !== "string") {
      throw new TypeError(`workflow ${key} escalation role must be a role key`);
    }
    validateKey(entry.role, `workflow ${key} escalation role`);
    previousCycles = entry.afterCycles as number;
    return { afterCycles: previousCycles, role: entry.role };
  });
  return { key, stages, maxReworkCycles, escalation };
}

function validateWorkflowReferences(
  workflows: Readonly<Record<string, Workflow>>,
  roles: Readonly<Record<string, Role>>,
): void {
  for (const [key, workflow] of Object.entries(workflows)) {
    for (const stage of workflow.stages) {
      if (!roles[stage]) throw new TypeError(`workflow ${key} references unknown stage role ${stage}`);
    }
    for (const entry of workflow.escalation) {
      if (!roles[entry.role]) {
        throw new TypeError(`workflow ${key} references unknown escalation role ${entry.role}`);
      }
    }
  }
}

function freezeTeam(team: { roles: Record<string, Role>; workflows: Record<string, Workflow> }): TeamCatalog {
  const roles = Object.fromEntries(
    Object.entries(team.roles).map(([key, role]) => [key, Object.freeze({ ...role })]),
  );
  const workflows = Object.fromEntries(
    Object.entries(team.workflows).map(([key, workflow]) => [
      key,
      Object.freeze({
        ...workflow,
        stages: Object.freeze([...workflow.stages]),
        escalation: Object.freeze(workflow.escalation.map((entry) => Object.freeze({ ...entry }))),
      }),
    ]),
  );
  return Object.freeze({ roles: Object.freeze(roles), workflows: Object.freeze(workflows) });
}

function cloneDefaultTeam(): TeamCatalog {
  return freezeTeam({
    roles: Object.fromEntries(
      Object.entries(DEFAULT_TEAM_CATALOG.roles).map(([key, role]) => [key, { ...role }]),
    ),
    workflows: Object.fromEntries(
      Object.entries(DEFAULT_TEAM_CATALOG.workflows).map(([key, workflow]) => [
        key,
        {
          ...workflow,
          stages: [...workflow.stages],
          escalation: workflow.escalation.map((entry) => ({ ...entry })),
        },
      ]),
    ),
  });
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError(`${label} must be an object keyed by name`);
  return value;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`unknown ${label} field ${key}`);
  }
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const text = value.replace(/\r\n?/gu, "\n").trim();
  if (!text) throw new TypeError(`${label} must not be empty`);
  if (text.length > maximum) throw new RangeError(`${label} must not exceed ${maximum} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
    throw new TypeError(`${label} contains unsafe control characters`);
  }
  return text;
}

function validateKey(value: string, label: string): void {
  if (!ROLE_KEY.test(value)) throw new TypeError(`${label} key is invalid: ${value}`);
}

function assertCycle(cycles: number): void {
  if (!Number.isSafeInteger(cycles) || cycles < 0) {
    throw new RangeError("rework cycles must be a non-negative integer");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
