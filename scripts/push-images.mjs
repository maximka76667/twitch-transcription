#!/usr/bin/env node
// Builds the three backend images and pushes them to Docker Hub under a version
// tag (not :latest) - see docs/docker-images.md for why.
//
// Usage:
//   node scripts/push-images.mjs            # version = git describe --tags --always
//   node scripts/push-images.mjs v0.2.0     # explicit version
//
// Requires `docker login` beforehand.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { step, warn, run, capture } from "./lib.mjs";

// --- Config: change things here ---
const DOCKERHUB_USER = "max76667";
const SERVICES = ["ingest", "transcriber", "api"];
// Where the Dockerfiles live and which kustomization gets the new version.
const BACKEND_DIR = "backend";
const OVERLAY_FILE = "k8s/overlays/aws/kustomization.yaml";
// Path to print in the "deploy with" hint.
const KUBECONFIG = "ansible/kubeconfig-aws.yaml";
// -----------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const backendDir = path.join(repoRoot, BACKEND_DIR);
const overlayFile = path.join(repoRoot, OVERLAY_FILE);

const imageName = (svc, tag) =>
  `${DOCKERHUB_USER}/twitch-transcription-${svc}:${tag}`;

function getVersion(explicit) {
  if (explicit) return explicit;

  // Images only depend on backend/, so only uncommitted changes there matter.
  const dirty = capture("git", ["status", "--porcelain", "--", BACKEND_DIR], {
    cwd: repoRoot,
  });
  if (dirty.stdout.trim()) {
    throw new Error(
      `${BACKEND_DIR}/ has uncommitted changes - commit them first so the version identifies real code, or pass an explicit version`,
    );
  }

  const described = capture("git", ["describe", "--tags", "--always"], {
    cwd: repoRoot,
  });
  if (described.status !== 0 || !described.stdout.trim()) {
    throw new Error("git describe failed - is this a git repository?");
  }
  return described.stdout.trim();
}

const version = getVersion(process.argv[2]);
console.log(`Publishing version ${version}`);

for (const svc of SERVICES) {
  const image = imageName(svc, version);

  // Never overwrite a tag: if it's already on Docker Hub, leave it alone.
  if (capture("docker", ["manifest", "inspect", image]).status === 0) {
    warn(`${image} already exists on Docker Hub, skipping build/push.`);
    continue;
  }

  step(`Building and pushing ${image}`);
  run("docker", ["build", "-f", `Dockerfile.${svc}`, "-t", image, "."], {
    cwd: backendDir,
  });
  run("docker", ["push", image]);
}

// Record the version in the AWS overlay so `kubectl apply -k` deploys it. The
// version appears in three places: two newTag lines (transcriber, api) and the
// ingest patch's image line (the images: shortcut doesn't reach a ScaledJob).
step(`Setting version ${version} in the AWS overlay`);
let overlay = readFileSync(overlayFile, "utf8");

// "value: <user>/twitch-transcription-ingest:" - built from the config above,
// with regex special characters escaped.
const ingestPrefix = `value: ${imageName("ingest", "")}`;
const ingestRegex = new RegExp(
  `(${ingestPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\S+`,
  "g",
);

const tagLines = overlay.match(/newTag: \S+/g) ?? [];
const ingestLines = overlay.match(ingestRegex) ?? [];
if (tagLines.length !== 2 || ingestLines.length !== 1) {
  throw new Error(
    `expected 2 newTag lines and 1 ingest image line in ${OVERLAY_FILE}, found ${tagLines.length} and ${ingestLines.length}`,
  );
}

overlay = overlay.replace(/newTag: \S+/g, `newTag: ${version}`);
overlay = overlay.replace(ingestRegex, (_match, prefix) => prefix + version);
writeFileSync(overlayFile, overlay);

console.log(`\nDone. Images are on Docker Hub as version ${version}.`);
console.log(
  `Overlay updated. Deploy with: kubectl apply -k ${path.dirname(OVERLAY_FILE)} --kubeconfig ${KUBECONFIG}`,
);
