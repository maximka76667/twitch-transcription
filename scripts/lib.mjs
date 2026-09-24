// Shared helpers for the scripts/*.mjs cluster-management scripts. Cross-platform
// (Windows/Linux/Mac) - just shells out to docker/k3d/kubectl/helm.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLUSTER_NAME = "twitch-transcription";
export const NAMESPACE = "twitch-transcription";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MONITORING_VALUES = path.join(
  repoRoot,
  "k8s",
  "monitoring",
  "values.yaml",
);
const PODMONITORS_DIR = path.join(repoRoot, "k8s", "monitoring", "podmonitors");

// Pinned, not "latest" - reproducibility (same principle as
// .terraform.lock.hcl/package-lock.json): an unpinned chart install could
// silently pick up a different version - and a different values.yaml schema
// - between one run and the next with no code change on our end. Bump this
// deliberately, not automatically.
const MONITORING_CHART_VERSION = "91.4.1";

export function step(msg) {
  console.log(`\n==> ${msg}`);
}

export function warn(msg) {
  console.log(`    (!) ${msg}`);
}

// shell: true so PATH resolution finds Windows shims (.exe/.cmd, e.g. k3d/kubectl/helm
// installed via scoop/choco) - without it, Windows spawnSync can ENOENT on names that
// resolve fine from an interactive shell. Node quotes the args array for us either way.

// Run a command, streaming output live. Throws on non-zero exit unless allowFailure.
export function run(cmd, cmdArgs, { cwd, allowFailure = false } = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd,
    stdio: "inherit",
    shell: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `${cmd} ${cmdArgs.join(" ")} exited with code ${result.status}`,
    );
  }
  return result.status;
}

// Same as run(), but captures stdout instead of streaming it (for JSON/status checks).
export function capture(cmd, cmdArgs, { cwd } = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd,
    encoding: "utf8",
    shell: true,
  });
  return { status: result.status, stdout: result.stdout ?? "" };
}

// If a values file was encrypted with SOPS (has a top-level `sops:` key),
// decrypt it to a throwaway temp file and return that path instead - helm
// has no idea what SOPS or ENC[...] means, it just needs real values at the
// moment it runs. A plain, unencrypted file passes through untouched, so
// this is safe to call on every values file regardless of whether it's
// actually encrypted.
function resolveValuesFile(filePath) {
  const raw = readFileSync(filePath, "utf8");
  if (!/^sops:/m.test(raw)) return filePath;

  const decrypted = capture("sops", ["--decrypt", filePath]);
  if (decrypted.status !== 0) {
    throw new Error(
      `sops failed to decrypt ${filePath} - is the age key at %AppData%\\sops\\age\\keys.txt (or $SOPS_AGE_KEY_FILE) present?`,
    );
  }
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "sops-decrypted-"));
  const tmpFile = path.join(tmpDir, path.basename(filePath));
  writeFileSync(tmpFile, decrypted.stdout);
  return tmpFile;
}

// Installs (or upgrades) the kube-prometheus-stack helm release plus our PodMonitors.
// Shared by the local k3d script and the AWS deploy script.
//   kubeconfig:  path to talk to a specific cluster (AWS); omitted = current kubectl context
//   extraValues: more values files layered on top of the base one (later files win)
export function installMonitoring({ kubeconfig, extraValues = [] } = {}) {
  if (!existsSync(MONITORING_VALUES)) {
    warn(
      "No k8s/monitoring/values.yaml yet, skipping Prometheus/Grafana (add that file to enable this step).",
    );
    return;
  }

  const kubeArgs = kubeconfig ? ["--kubeconfig", kubeconfig] : [];
  const valuesArgs = [MONITORING_VALUES, ...extraValues]
    .map(resolveValuesFile)
    .flatMap((f) => ["-f", f]);

  step("Checking 'monitoring' helm release");
  // repo add/update runs unconditionally, before the install-vs-upgrade
  // branch - the local helm repo cache (%TEMP%\helm\repository\ on Windows)
  // can go missing between runs (e.g. temp cleared), and `helm upgrade`
  // needs the cached index just as much as `helm install` does.
  run(
    "helm",
    [
      "repo",
      "add",
      "prometheus-community",
      "https://prometheus-community.github.io/helm-charts",
    ],
    { allowFailure: true },
  );
  run("helm", ["repo", "update", "prometheus-community"]);

  const chart = [
    "prometheus-community/kube-prometheus-stack",
    "--version",
    MONITORING_CHART_VERSION,
    "-n",
    "monitoring",
  ];
  const status = capture("helm", [
    "status",
    "monitoring",
    "-n",
    "monitoring",
    ...kubeArgs,
  ]);
  if (status.status === 0) {
    warn(
      "'monitoring' release already running, upgrading in case values changed.",
    );
    run("helm", ["upgrade", "monitoring", ...chart, ...valuesArgs, ...kubeArgs]);
  } else {
    console.log(
      "No existing 'monitoring' release, installing kube-prometheus-stack",
    );
    run("helm", [
      "install",
      "monitoring",
      ...chart,
      "--create-namespace",
      ...valuesArgs,
      ...kubeArgs,
    ]);
  }

  // PodMonitor/ServiceMonitor CRDs only exist now that the chart above is installed -
  // apply these separately from the main k8s/ folder for that reason (see comment in
  // k8s/monitoring/podmonitors/transcriber.yaml).
  if (existsSync(PODMONITORS_DIR)) {
    step("Applying PodMonitors");
    run("kubectl", ["apply", "-f", PODMONITORS_DIR, ...kubeArgs]);
  }
}

// Returns the `k3d cluster list -o json` entry for CLUSTER_NAME, or undefined if it
// doesn't exist.
export function findCluster() {
  const listResult = capture("k3d", ["cluster", "list", "-o", "json"]);
  const clusters =
    listResult.status === 0 ? JSON.parse(listResult.stdout || "[]") : [];
  return clusters.find((c) => c.name === CLUSTER_NAME);
}
