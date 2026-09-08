#!/usr/bin/env node
// Full teardown of the k3d/Kubernetes stack (see README.md "Kubernetes (k3d)" -> "Stop /
// resume" -> "Full teardown"). Deletes the k3d cluster entirely - next run of
// scripts/start-k8s.mjs starts from scratch (rebuild+reimport+reapply, and reinstalls
// KEDA/monitoring if configured).
//
// Cross-platform (Windows/Linux/Mac) - just shells out to k3d.
//
// Usage:
//   node scripts/delete-k8s.mjs

import { CLUSTER_NAME, step, run, findCluster } from "./lib.mjs";

step(`Checking k3d cluster '${CLUSTER_NAME}'`);
const existing = findCluster();

if (!existing) {
  console.log(`Cluster '${CLUSTER_NAME}' doesn't exist, nothing to delete.`);
  process.exit(0);
}

step(`Deleting k3d cluster '${CLUSTER_NAME}'`);
run("k3d", ["cluster", "delete", CLUSTER_NAME]);

console.log("\nDone. Everything (pods, images imported into the cluster, helm releases) is gone.");
console.log("Run scripts/start-k8s.mjs to start fresh.");
