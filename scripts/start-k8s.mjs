#!/usr/bin/env node
// Brings up the k3d/Kubernetes stack from a cold start (see README.md "Kubernetes (k3d)").
// Cross-platform (Windows/Linux/Mac) - just shells out to docker/k3d/kubectl/helm.
//
// Brings everything up, then waits for Ctrl+C. On Ctrl+C it pauses everything it
// started (frontend dev server + k3d cluster stop) - state is kept, so running this
// script again resumes instantly instead of rebuilding from scratch.
//
// Usage:
//   node scripts/start-k8s.mjs                 # build+import images, apply manifests, start monitoring if configured, start frontend, wait for Ctrl+C
//   node scripts/start-k8s.mjs --skip-build     # reuse existing images (no code changes since last run)
//   node scripts/start-k8s.mjs --skip-frontend  # don't start the frontend dev server
//   node scripts/start-k8s.mjs --watch          # tail pod status instead of starting the frontend

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLUSTER_NAME, NAMESPACE, step, warn, run, capture, findCluster } from "./lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const backendDir = path.join(repoRoot, "backend");
const frontendDir = path.join(repoRoot, "frontend");
const k8sDir = path.join(repoRoot, "k8s");
const monitoringValues = path.join(k8sDir, "monitoring", "values.yaml");
const podMonitorsDir = path.join(k8sDir, "monitoring", "podmonitors");

const SERVICES = ["ingest", "transcriber", "api"];

const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");
const skipFrontend = args.includes("--skip-frontend");
const watch = args.includes("--watch");

// Each step below owns its own "is this already running" check and warns instead of
// re-doing work when it is. main() just calls them in order.

function createCluster() {
  run("k3d", [
    "cluster",
    "create",
    CLUSTER_NAME,
    "-p",
    "8000:8000@loadbalancer",
  ]);
}

function startCluster() {
  step(`Checking k3d cluster '${CLUSTER_NAME}'`);
  const existing = findCluster();

  if (!existing) {
    console.log("Cluster not found, creating it");
    createCluster();
    return;
  }

  if (!existing.serversRunning) {
    console.log("Cluster exists but is stopped, starting it");
    // `k3d cluster start` re-binds the SAME host port the cluster was created with
    // (e.g. loadbalancer port). On Windows that port can go stale between sessions -
    // Hyper-V/WSL2 dynamically reserves port ranges on boot/sleep/VPN-connect, and if
    // this cluster's port now falls in an excluded range, start fails permanently
    // (retrying the same port never helps). `cluster create` doesn't have this problem
    // since it rolls a fresh random port every time - so fall back to delete+recreate.
    const status = run("k3d", ["cluster", "start", CLUSTER_NAME], {
      allowFailure: true,
    });
    if (status !== 0) {
      step("Cluster failed to start (likely a stale port - see comment above)");
      warn(
        "Falling back to delete+recreate. This forces a fresh cluster, so KEDA and monitoring will need to reinstall this run - expect it to take longer than usual.",
      );
      run("k3d", ["cluster", "delete", CLUSTER_NAME]);
      createCluster();
      console.log("Cluster recreated successfully.");
    }
    return;
  }
  warn(`Cluster '${CLUSTER_NAME}' is already running, skipping create/start.`);
}

function buildAndImportImages() {
  if (skipBuild) {
    warn("--skip-build passed, skipping image build/import.");
    return;
  }

  step("Building backend images");
  for (const svc of SERVICES) {
    run(
      "docker",
      [
        "build",
        "-f",
        `Dockerfile.${svc}`,
        "-t",
        `twitch-transcription-${svc}:local`,
        ".",
      ],
      {
        cwd: backendDir,
      },
    );
  }

  step("Importing images into k3d");
  const images = SERVICES.map((s) => `twitch-transcription-${s}:local`);
  run("k3d", ["image", "import", ...images, "-c", CLUSTER_NAME]);
}

function startKeda() {
  step("Checking KEDA (needed for ScaledJob/ScaledObject CRDs in k8s/06-07)");
  const status = capture("helm", ["status", "keda", "-n", "keda"]);
  if (status.status === 0) {
    warn("'keda' release already installed, skipping.");
    return;
  }

  console.log("KEDA not found, installing it (CRDs must exist before applying k8s/ manifests)");
  run("helm", ["repo", "add", "kedacore", "https://kedacore.github.io/charts"], {
    allowFailure: true,
  });
  run("helm", ["repo", "update", "kedacore"]);
  run("helm", [
    "install", "keda", "kedacore/keda",
    "-n", "keda", "--create-namespace",
    "--wait",
  ]);
}

function applyManifests() {
  step("Applying k8s manifests");
  run("kubectl", ["apply", "-f", k8sDir]);

  // k3d/k8s won't notice an image's contents changed just because the tag is reused,
  // so force a rollout whenever we just imported new images.
  if (!skipBuild) {
    step("Restarting deployments to pick up new images");
    for (const svc of ["transcriber", "api"]) {
      run(
        "kubectl",
        ["rollout", "restart", `deployment/${svc}`, "-n", NAMESPACE],
        { allowFailure: true },
      );
    }
  }
}

function startMonitoring() {
  if (!existsSync(monitoringValues)) {
    warn(
      "No k8s/monitoring/values.yaml yet, skipping Prometheus/Grafana (add that file to enable this step).",
    );
    return;
  }

  step("Checking 'monitoring' helm release");
  const status = capture("helm", ["status", "monitoring", "-n", "monitoring"]);
  if (status.status === 0) {
    warn(
      "'monitoring' release already running, upgrading in case values changed.",
    );
    run("helm", [
      "upgrade",
      "monitoring",
      "prometheus-community/kube-prometheus-stack",
      "-n",
      "monitoring",
      "-f",
      monitoringValues,
    ]);
  } else {
    console.log(
      "No existing 'monitoring' release, installing kube-prometheus-stack",
    );
    run(
      "helm",
      [
        "repo",
        "add",
        "prometheus-community",
        "https://prometheus-community.github.io/helm-charts",
      ],
      {
        allowFailure: true,
      },
    );
    run("helm", ["repo", "update", "prometheus-community"]);
    run("helm", [
      "install",
      "monitoring",
      "prometheus-community/kube-prometheus-stack",
      "-n",
      "monitoring",
      "--create-namespace",
      "-f",
      monitoringValues,
    ]);
  }

  // PodMonitor/ServiceMonitor CRDs only exist now that the chart above is installed -
  // apply these separately from the main k8s/ folder for that reason (see comment in
  // k8s/monitoring/podmonitors/transcriber.yaml).
  if (existsSync(podMonitorsDir)) {
    step("Applying PodMonitors");
    run("kubectl", ["apply", "-f", podMonitorsDir]);
  }
}

function showStatus() {
  step("Pod status");
  run("kubectl", ["get", "pods", "-n", NAMESPACE]);
}

function printHints() {
  console.log("\napi reachable at http://localhost:8000");
  if (existsSync(monitoringValues)) {
    console.log("Grafana:           kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80  (login: admin / admin)");
  }
  console.log(`Watch pods:        kubectl get pods -n ${NAMESPACE} -w`);
  console.log(`Tail logs:         kubectl logs -f -n ${NAMESPACE} deployment/<service>`);
  console.log("Up and running. Press Ctrl+C to stop the frontend and pause the cluster.");
}

// Started async (not spawnSync) so main() can move on and wait for Ctrl+C instead of
// blocking here forever.
let frontendChild = null;

function startFrontend() {
  if (skipFrontend) {
    warn("--skip-frontend passed, not starting the frontend dev server.");
    return;
  }
  if (watch) {
    warn("--watch passed, not starting the frontend dev server.");
    return;
  }

  step("Starting frontend dev server");
  if (!existsSync(path.join(frontendDir, "node_modules"))) {
    console.log("node_modules not found, running npm install");
    run("npm", ["install"], { cwd: frontendDir });
  }
  frontendChild = spawn("npm", ["run", "dev"], {
    cwd: frontendDir,
    stdio: "inherit",
    shell: true,
  });
}

// Pauses everything this script started - keeps all state (k3d cluster state, helm
// release, etc.) so the next run of this script resumes instantly instead of rebuilding.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("\n\n==> Stopping");
  if (frontendChild && frontendChild.exitCode === null) {
    console.log("Stopping frontend dev server");
    frontendChild.kill();
  }
  console.log(`Pausing k3d cluster '${CLUSTER_NAME}' (state is kept - resume by running this script again)`);
  spawnSync("k3d", ["cluster", "stop", CLUSTER_NAME], { stdio: "inherit", shell: true });
  console.log("Done.");
  process.exit(0);
}

function main() {
  startCluster();
  buildAndImportImages();
  startKeda();
  applyManifests();
  startMonitoring();
  showStatus();
  startFrontend();

  process.on("SIGINT", shutdown);

  if (watch) {
    console.log(`\nWatching pod status. Press Ctrl+C to stop.`);
    run("kubectl", ["get", "pods", "-n", NAMESPACE, "-w"], { allowFailure: true });
    shutdown();
    return;
  }

  printHints();
  process.stdin.resume();
}

main();
