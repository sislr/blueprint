import { existsSync } from "node:fs";
import path from "node:path";

/**
 * How the agent authenticates, first match wins. Values come from the environment or blueprint's .env:
 *   1. a cloud provider configured the way Claude Code expects it
 *      (CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX or CLAUDE_CODE_USE_FOUNDRY plus that provider's settings)
 *   2. ANTHROPIC_API_KEY
 *   3. otherwise Claude Code's own login: CLAUDE_CODE_OAUTH_TOKEN, or `claude` logged in on this machine
 */

const envFile = path.resolve(import.meta.dirname, "../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const PROVIDERS = {
  CLAUDE_CODE_USE_BEDROCK: "Amazon Bedrock",
  CLAUDE_CODE_USE_VERTEX: "Google Vertex AI",
  CLAUDE_CODE_USE_FOUNDRY: "Microsoft Foundry",
} as const;

const cloudProvider = (): string | undefined =>
  Object.entries(PROVIDERS).find(([key]) => process.env[key] && process.env[key] !== "0")?.[1];

export function authDescription(): string {
  return (
    cloudProvider() ??
    (process.env.ANTHROPIC_API_KEY
      ? "ANTHROPIC_API_KEY"
      : process.env.CLAUDE_CODE_OAUTH_TOKEN
        ? "Claude Code login (CLAUDE_CODE_OAUTH_TOKEN)"
        : "Claude Code login on this machine")
  );
}

export function agentEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "blueprint/0.1.0" };
  // With an API key set, make sure the CLI uses it rather than a login token.
  if (env.ANTHROPIC_API_KEY) delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}
