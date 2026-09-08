// Shared helpers for the scripts/*.mjs cluster-management scripts. Cross-platform
// (Windows/Linux/Mac) - just shells out to docker/k3d/kubectl/helm.

import { spawnSync } from "node:child_process";

export const CLUSTER_NAME = "twitch-transcription";
export const NAMESPACE = "twitch-transcription";

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

// Returns the `k3d cluster list -o json` entry for CLUSTER_NAME, or undefined if it
// doesn't exist.
export function findCluster() {
  const listResult = capture("k3d", ["cluster", "list", "-o", "json"]);
  const clusters =
    listResult.status === 0 ? JSON.parse(listResult.stdout || "[]") : [];
  return clusters.find((c) => c.name === CLUSTER_NAME);
}
