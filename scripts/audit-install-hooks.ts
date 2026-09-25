import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const lifecycleNames = ["preinstall", "install", "postinstall"] as const;

type Finding = {
  workspace: "root" | "launcher";
  package: string;
  version: string;
  path: string;
  scripts: Partial<Record<(typeof lifecycleNames)[number], string>>;
};

function packageDirectories(nodeModules: string): string[] {
  if (!existsSync(nodeModules)) return [];
  const out: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".bin" || entry.name.startsWith(".")) continue;
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        visit(target);
        continue;
      }
      if (existsSync(join(target, "package.json"))) out.push(target);
      const nested = join(target, "node_modules");
      if (existsSync(nested) && lstatSync(nested).isDirectory()) visit(nested);
    }
  };
  visit(nodeModules);
  return out;
}

function findingsFor(workspace: "root" | "launcher", nodeModules: string): Finding[] {
  const findings: Finding[] = [];
  for (const directory of packageDirectories(nodeModules)) {
    let manifest: { name?: unknown; version?: unknown; scripts?: unknown };
    try { manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")); }
    catch { continue; }
    if (!manifest.scripts || typeof manifest.scripts !== "object" || Array.isArray(manifest.scripts)) continue;
    const scripts: Finding["scripts"] = {};
    for (const name of lifecycleNames) {
      const value = (manifest.scripts as Record<string, unknown>)[name];
      if (typeof value === "string" && value.trim()) scripts[name] = value.trim();
    }
    if (!Object.keys(scripts).length) continue;
    findings.push({
      workspace,
      package: typeof manifest.name === "string" ? manifest.name : "<unnamed>",
      version: typeof manifest.version === "string" ? manifest.version : "<unknown>",
      path: relative(root, directory).replaceAll("\\", "/"),
      scripts,
    });
  }
  return findings;
}

const findings = [
  ...findingsFor("root", join(root, "node_modules")),
  ...findingsFor("launcher", join(root, "launcher", "node_modules")),
].sort((left, right) => `${left.workspace}/${left.package}/${left.version}/${left.path}`.localeCompare(`${right.workspace}/${right.package}/${right.version}/${right.path}`));

if (!existsSync(join(root, "node_modules")) || !existsSync(join(root, "launcher", "node_modules"))) {
  throw new Error("Run frozen installs in both root and launcher before auditing lifecycle hooks");
}

process.stdout.write(`${JSON.stringify({ schemaVersion: 1, lifecycleNames, findings }, null, 2)}\n`);
