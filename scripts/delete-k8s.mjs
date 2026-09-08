#!/usr/bin/env node
// Full teardown of the k3d/Kubernetes stack (see README.md "Kubernetes (k3d)" -> "Stop /
// resume" -> "Full teardown"). Deletes the k3d cluster entirely - next run of
// scripts/start-k8s.mjs starts from scratch (rebuild+reimport+reapply, and reinstalls
// monitoring if k8s/monitoring/values.yaml exists).
//
// Cross-platform (Windows/Linux/Mac) - just shells out to k3d.
//
// Usage:
//   node scripts/delete-k8s.mjs

import { spawnSync } from "node:child_process";

const CLUSTER_NAME = "twitch-transcription";

function step(msg) {
  console.log(`\n==> ${msg}`);
}

function capture(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, { encoding: "utf8", shell: true });
  return { status: result.status, stdout: result.stdout ?? "" };
}

step(`Checking k3d cluster '${CLUSTER_NAME}'`);
const listResult = capture("k3d", ["cluster", "list", "-o", "json"]);
const clusters = listResult.status === 0 ? JSON.parse(listResult.stdout || "[]") : [];
const existing = clusters.find((c) => c.name === CLUSTER_NAME);

if (!existing) {
  console.log(`Cluster '${CLUSTER_NAME}' doesn't exist, nothing to delete.`);
  process.exit(0);
}

step(`Deleting k3d cluster '${CLUSTER_NAME}'`);
const result = spawnSync("k3d", ["cluster", "delete", CLUSTER_NAME], {
  stdio: "inherit",
  shell: true,
});
if (result.status !== 0) {
  throw new Error(`k3d cluster delete exited with code ${result.status}`);
}

console.log("\nDone. Everything (pods, images imported into the cluster, helm releases) is gone.");
console.log("Run scripts/start-k8s.mjs to start fresh.");
