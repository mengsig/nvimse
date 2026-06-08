// MCP config merge — port of nvime's lua/nvime/mcp.lua. Writes a merged
// mcp config the providers can consume (--mcp-config for claude). The self
// server is the bundled node script dist/mcp/server.js.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { config } from "./runtime";
import { nvimePath, readJson, workspaceRoot } from "./paths";
import { gitRoot } from "./git";

let extensionDir = process.cwd();
export function setExtensionDir(dir: string): void {
  extensionDir = dir;
}

function projectConfigPath(): string {
  return nvimePath("mcp.json", config().mcp.configPath);
}

function readProjectServers(): Record<string, any> {
  const data = readJson<any>(projectConfigPath(), {});
  return data.mcpServers || data.servers || {};
}

function selfServer(): Record<string, any> {
  const root = workspaceRoot();
  return {
    nvime: {
      type: "stdio",
      command: process.execPath,
      args: [path.join(extensionDir, "dist", "mcp", "server.js")],
      env: { NVIME_REPO_ROOT: root },
    },
  };
}

export function buildConfig(): { mcpServers: Record<string, any> } {
  const servers: Record<string, any> = {};
  Object.assign(servers, config().mcp.servers || {});
  Object.assign(servers, readProjectServers());
  if (config().mcp.exposeSelf) Object.assign(servers, selfServer());
  return { mcpServers: servers };
}

export function servers(): Record<string, any> {
  return buildConfig().mcpServers;
}

/** Returns a stable file path to the merged config, or null when disabled/empty. */
export function configPath(): string | null {
  if (config().mcp.enabled === false) return null;
  const merged = buildConfig();
  if (Object.keys(merged.mcpServers).length === 0) return null;
  const root = gitRoot(workspaceRoot());
  const cacheDir = root ? path.join(root, ".nvime", "mcp") : path.join(os.tmpdir(), "nvimse-mcp");
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, "merged.json");
  const content = JSON.stringify(merged, null, 2);
  let prev = "";
  try {
    prev = fs.readFileSync(file, "utf8");
  } catch {
    /* ignore */
  }
  if (prev !== content) fs.writeFileSync(file, content);
  return file;
}

export function ensureProjectConfig(): string {
  const p = projectConfigPath();
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ mcpServers: {} }, null, 2) + "\n");
  }
  return p;
}
