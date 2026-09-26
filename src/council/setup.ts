import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  currentRuntimeCommand,
  defaultConfig,
  getConfigPath,
  loadConfigForSetup,
  saveConfig,
  type AppConfig,
  type RuntimeMode,
} from "../config";
import {
  createTunnelConfig,
  installRuntimeKey,
  installTunnelClient,
} from "../tunnel";
import { VERSION } from "../version";
import { COUNCIL_CONNECTOR_NAME } from "./wake-engine";

export interface CouncilSetupOptions {
  browserHostDescriptorPath: string;
  tunnelId?: string;
  runtimeKeyFile?: string;
  tunnelClientPath?: string;
  localOnly?: boolean;
}

export interface CouncilSetupResult {
  mode: RuntimeMode;
  appName: string;
  configPath: string;
  reusedCredentials: boolean;
}

function existingCodexWebConfig(): AppConfig | undefined {
  if (!existsSync(getConfigPath())) return undefined;
  return loadConfigForSetup();
}

export async function setupCouncil(options: CouncilSetupOptions): Promise<CouncilSetupResult> {
  const descriptorPath = resolve(options.browserHostDescriptorPath);
  if (!existsSync(descriptorPath)) {
    throw new Error(`Launcher browser descriptor does not exist: ${descriptorPath}`);
  }

  // Council local-only mode is the first-class default. A saved Council Tunnel remains reusable,
  // and fresh Tunnel credentials may explicitly opt this installation into full mode. Council never
  // reads or mutates CODEX_HOME, ~/.codex/config.toml, model caches, or the legacy integration journal.
  const existing = existingCodexWebConfig();
  const previousCouncil = existing?.appName === COUNCIL_CONNECTOR_NAME
    && (existing.mode === "browser-only" || existing.mode === "full")
    ? existing
    : undefined;
  const reusableTunnel = previousCouncil?.mode === "full" ? previousCouncil.tunnel : undefined;
  const freshCredentials = Boolean(options.tunnelId || options.runtimeKeyFile);
  if (freshCredentials && (!options.tunnelId || !options.runtimeKeyFile)) {
    throw new Error("Council setup requires both tunnelId and runtimeKeyFile when replacing tunnel credentials");
  }
  if (options.localOnly && freshCredentials) {
    throw new Error("Council local-only setup cannot also replace Tunnel credentials");
  }

  const useTunnel = options.localOnly !== true && (freshCredentials || Boolean(reusableTunnel));
  const mode: RuntimeMode = useTunnel ? "full" : "browser-only";
  const base = previousCouncil ?? defaultConfig(mode);
  const tunnel = useTunnel
    ? freshCredentials
      ? createTunnelConfig({
          binaryPath: await installTunnelClient(options.tunnelClientPath),
          tunnelId: options.tunnelId!,
          runtimeKeyFile: installRuntimeKey(options.runtimeKeyFile!),
          profileName: "codexweb-council",
          alias: "codexweb-council",
        })
      : createTunnelConfig({
          binaryPath: await installTunnelClient(),
          tunnelId: reusableTunnel!.tunnelId,
          runtimeKeyFile: reusableTunnel!.runtimeKeyFile,
          profileName: "codexweb-council",
          alias: "codexweb-council",
        })
    : undefined;

  const common: AppConfig = {
    ...base,
    version: 3,
    releaseVersion: VERSION,
    mode,
    appName: COUNCIL_CONNECTOR_NAME,
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    runtimeCommand: currentRuntimeCommand(),
    acknowledgedUnofficialAt: base.acknowledgedUnofficialAt ?? new Date().toISOString(),
  };
  const config: AppConfig = tunnel
    ? { ...common, tunnel }
    : (() => {
        const { tunnel: _discardedTunnel, ...local } = common;
        return local;
      })();
  saveConfig(config);
  return {
    mode,
    appName: COUNCIL_CONNECTOR_NAME,
    configPath: getConfigPath(),
    reusedCredentials: useTunnel && !freshCredentials,
  };
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1]?.trim();
  if (!value) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

export async function runCouncilSetupCommand(input: string[]): Promise<void> {
  const args = [...input];
  const descriptor = takeOption(args, "--browser-host-descriptor");
  const tunnelId = takeOption(args, "--tunnel-id");
  const runtimeKeyFile = takeOption(args, "--runtime-key-file");
  const tunnelClientPath = takeOption(args, "--tunnel-client-path");
  const localOnly = takeFlag(args, "--local-only");
  if (args.length > 0) throw new Error(`Unknown Council setup arguments: ${args.join(" ")}`);
  if (!descriptor) throw new Error("council-setup requires --browser-host-descriptor");
  const result = await setupCouncil({
    browserHostDescriptorPath: descriptor,
    ...(tunnelId ? { tunnelId } : {}),
    ...(runtimeKeyFile ? { runtimeKeyFile } : {}),
    ...(tunnelClientPath ? { tunnelClientPath } : {}),
    ...(localOnly ? { localOnly: true } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
