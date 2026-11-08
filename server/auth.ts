import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Blueprint runs the agent on your Claude subscription (OAuth), never on an API key.
 *
 * Credentials, in order:
 *   1. CLAUDE_CODE_OAUTH_TOKEN from the environment or blueprint's .env (create with `claude setup-token`)
 *   2. your local Claude Code login (`claude login`, stored in the macOS keychain)
 *
 * Anything that would make the CLI bill an API account or another provider is removed from the
 * agent's environment, and each run verifies the credential the CLI actually picked.
 */

const envFile = path.resolve(import.meta.dirname, "../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const STRIPPED = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

export function agentEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "blueprint/0.1.0" };
  for (const key of STRIPPED) delete env[key];
  return env;
}

export const authDescription = () =>
  process.env.CLAUDE_CODE_OAUTH_TOKEN ? "OAuth token (CLAUDE_CODE_OAUTH_TOKEN)" : "local Claude Code login";

export const strippedVars = () => STRIPPED.filter((k) => process.env[k]);
