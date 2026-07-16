import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

import {
  SCREEN_DETECTION_AGENT_TYPES,
  SUPPORTED_AGENT_TYPES,
  type SupportedAgentType,
} from "../dispatch/agent-launch.js";

export function parseCurrentIntegrations(output: string): ReadonlySet<string> {
  const current = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^([a-z][a-z0-9-]*):\s+current\b/u.exec(line.trim());
    if (match) current.add(match[1]!);
  }
  return current;
}

export async function launchableAgentTypes(
  integrationStatusOutput: string,
  executableExists: (name: SupportedAgentType) => Promise<boolean> = executableExistsOnPath,
): Promise<readonly SupportedAgentType[]> {
  const current = parseCurrentIntegrations(integrationStatusOutput);
  const available: SupportedAgentType[] = [];
  for (const agentType of SUPPORTED_AGENT_TYPES) {
    if (!current.has(agentType) && !SCREEN_DETECTION_AGENT_TYPES.has(agentType)) continue;
    if (await executableExists(agentType)) available.push(agentType);
  }
  return available;
}

export async function executableExistsOnPath(
  name: SupportedAgentType,
  pathValue = process.env.PATH ?? "",
): Promise<boolean> {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    try {
      const candidate = join(directory, name);
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return true;
    } catch {
      // Continue through PATH; only executable files count as launchable.
    }
  }
  return false;
}
