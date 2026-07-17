#!/usr/bin/env node
import { resolveProjectPath } from "./core/paths.js";
import { createProject, validateProject } from "./core/project-store.js";
import { runAction } from "./core/action-runner.js";
import { listActions } from "./actions/registry.js";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const json = args.includes("--json");

  try {
    if (!command || command === "help") return printHelp();

    if (command === "actions:list") return output({ ok: true, actions: listActions() }, json);

    if (command === "project:create") {
      const projectArg = args.find((arg) => !arg.startsWith("--"));
      const projectRoot = resolveProjectPath(projectArg);
      const project = await createProject(projectRoot, { projectName: readOption(args, "--name"), productName: readOption(args, "--product"), officialUrl: readOption(args, "--url") });
      return output({ ok: true, projectRoot, project }, json);
    }

    if (command === "project:validate") {
      const projectRoot = resolveProjectPath(readOption(args, "--project") || args.find((arg) => !arg.startsWith("--")));
      const result = await validateProject(projectRoot);
      return output(result, json);
    }

    if (command === "run") {
      const actionId = args.find((arg) => !arg.startsWith("--"));
      const projectRoot = resolveProjectPath(readOption(args, "--project"));
      const dryRun = args.includes("--dry-run");
      const force = args.includes("--force");
      const input = readActionInput(args);
      const result = await runAction({ actionId, projectRoot, dryRun, force, input });
      return output(result, json || true);
    }

    throw new Error("\u672a\u77e5\u306e\u30b3\u30de\u30f3\u30c9\u3067\u3059: " + command);
  } catch (error) {
    output({ ok: false, errorCode: "CLI_ERROR", message: error.message }, json || true);
    process.exitCode = 1;
  }
}

function readActionInput(args) {
  const raw = readOption(args, "--input");
  const input = raw ? JSON.parse(raw) : {};
  const map = {
    "--product-id": "productId",
    "--strategy-id": "strategyId",
    "--template-id": "templateAdId",
    "--material-id": "materialId",
    "--banner-id": "bannerId"
  };
  for (const [option, key] of Object.entries(map)) {
    const value = readOption(args, option);
    if (value) input[key] = value;
  }
  return input;
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] || null;
}

function output(value, json) {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (value.ok === false) {
    console.log("NG: " + (value.message || "\u5931\u6557\u3057\u307e\u3057\u305f"));
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log("CMOAI CLI\n\nCommands:\n  actions:list\n  project:create <path> [--name name] [--product product] [--url url]\n  project:validate --project <path>\n  run <actionId> --project <path> [--dry-run] [--force] [--product-id id] [--strategy-id id] [--template-id id] [--material-id id] [--banner-id id] [--input json] [--json]\n");
}

main();
