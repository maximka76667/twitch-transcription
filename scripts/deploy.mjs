#!/usr/bin/env node
// Brings up the AWS deployment from nothing: terraform apply -> inventory.ini ->
// frontend build -> Ansible -> kubectl apply -> monitoring. See docs/aws-deploy.md.
//
// Usage:
//   node scripts/deploy.mjs up                  # everything, incl. Prometheus/Grafana
//   node scripts/deploy.mjs up --no-monitoring  # skip Prometheus/Grafana
//   node scripts/deploy.mjs monitoring          # (re)install just monitoring on the running box

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { step, run, capture, installMonitoring } from "./lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const terraformDir = path.join(repoRoot, "terraform");
const ansibleDir = path.join(repoRoot, "ansible");
const frontendDir = path.join(repoRoot, "frontend");
const overlayDir = path.join(repoRoot, "k8s", "overlays", "aws");
const kubeconfig = path.join(ansibleDir, "kubeconfig-aws.yaml");
const monitoringValuesAws = path.join(
  repoRoot,
  "k8s",
  "monitoring",
  "values-aws.yaml",
);

// Ansible needs a Linux environment; on Windows that's this WSL distro.
const WSL_DISTRO = "Ubuntu";

// Runs before anything that costs money, so a missing tool fails here instead of
// after terraform apply has already created the instance.
function preflight({ withMonitoring }) {
  step("Checking required tools");
  const isWindows = process.platform === "win32";

  const checks = [
    ["terraform", "terraform", ["version"]],
    ["kubectl", "kubectl", ["version", "--client"]],
    ["npm", "npm", ["--version"]],
  ];
  if (withMonitoring) checks.push(["helm", "helm", ["version"]]);
  if (isWindows) {
    checks.push([
      `ansible-playbook inside WSL (${WSL_DISTRO})`,
      "wsl",
      ["-d", WSL_DISTRO, "--", "ansible-playbook", "--version"],
    ]);
  } else {
    checks.push(["ansible-playbook", "ansible-playbook", ["--version"]]);
  }

  const missing = checks
    .filter(([, cmd, args]) => capture(cmd, args).status !== 0)
    .map(([name]) => name);

  const keyName = "~/.ssh/twitch-transcription";
  const hasKey = isWindows
    ? capture("wsl", [
        "-d",
        WSL_DISTRO,
        "--",
        "bash",
        "-c",
        `"test -f ${keyName}"`,
      ]).status === 0
    : existsSync(path.join(os.homedir(), ".ssh", "twitch-transcription"));
  if (!hasKey) {
    missing.push(
      `SSH key ${keyName}${isWindows ? ` (inside WSL, ${WSL_DISTRO})` : ""}`,
    );
  }

  if (missing.length) {
    throw new Error(`missing or not working: ${missing.join("; ")}`);
  }
}

async function getPublicIp() {
  const res = await fetch("https://api.ipify.org", {
    signal: AbortSignal.timeout(10000),
  });
  const ip = (await res.text()).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    throw new Error(`expected an IPv4 address from ipify, got: ${ip}`);
  }
  return ip;
}

function terraformApply(myIp) {
  step("Applying Terraform (review the plan, then type yes)");
  run("terraform", ["apply", "-var", `allowed_admin_cidr=${myIp}/32`], {
    cwd: terraformDir,
  });
  const out = capture("terraform", ["output", "-raw", "public_ip"], {
    cwd: terraformDir,
  });
  const ip = out.stdout.trim();
  if (out.status !== 0 || !ip) {
    throw new Error("could not read the public_ip output from Terraform");
  }
  return ip;
}

function writeInventory(ip) {
  step("Writing ansible/inventory.ini");
  const domain = `${ip.replaceAll(".", "-")}.sslip.io`;
  const example = readFileSync(
    path.join(ansibleDir, "inventory.ini.example"),
    "utf8",
  );
  if (
    !example.includes("REPLACE_WITH_TERRAFORM_PUBLIC_IP") ||
    !example.includes("REPLACE_WITH_IP_DASHED.sslip.io")
  ) {
    throw new Error("inventory.ini.example is missing its placeholders");
  }
  const inventory = example
    .replace("REPLACE_WITH_TERRAFORM_PUBLIC_IP", ip)
    .replace("REPLACE_WITH_IP_DASHED.sslip.io", domain);
  writeFileSync(path.join(ansibleDir, "inventory.ini"), inventory);
  return domain;
}

function buildFrontend() {
  step("Building the frontend");
  if (!existsSync(path.join(frontendDir, "node_modules"))) {
    run("npm", ["install"], { cwd: frontendDir });
  }
  run("npm", ["run", "build"], { cwd: frontendDir });
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 3000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitForSsh(ip) {
  step(`Waiting for SSH on ${ip}`);
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await canConnect(ip, 22)) return;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`${ip}:22 still not reachable after 5 minutes`);
}

function toWslPath(winPath) {
  const match = winPath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) throw new Error(`cannot convert to a WSL path: ${winPath}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function runAnsible() {
  step("Running the Ansible playbook");
  if (process.platform === "win32") {
    const dir = toWslPath(ansibleDir);
    // Quoted by hand: with shell: true the args are joined without escaping.
    const script = `"cd ${dir} && ANSIBLE_CONFIG=./ansible.cfg ansible-playbook -i inventory.ini playbook.yml"`;
    run("wsl", ["-d", WSL_DISTRO, "--", "bash", "-c", script]);
  } else {
    process.env.ANSIBLE_CONFIG = path.join(ansibleDir, "ansible.cfg");
    run("ansible-playbook", ["-i", "inventory.ini", "playbook.yml"], {
      cwd: ansibleDir,
    });
  }
}

function applyManifests() {
  step("Applying the AWS overlay");
  run("kubectl", ["apply", "-k", overlayDir, "--kubeconfig", kubeconfig]);
}

function setupMonitoring() {
  installMonitoring({ kubeconfig, extraValues: [monitoringValuesAws] });
  console.log(
    `Grafana: kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80 --kubeconfig ${path.relative(repoRoot, kubeconfig)}  (then http://localhost:3000, admin / admin)`,
  );
}

async function up({ withMonitoring }) {
  preflight({ withMonitoring });
  const myIp = await getPublicIp();
  console.log(`Your public IP: ${myIp}`);

  const ip = terraformApply(myIp);
  const domain = writeInventory(ip);
  buildFrontend();
  await waitForSsh(ip);
  runAnsible();
  applyManifests();
  if (withMonitoring) setupMonitoring();

  console.log(`\nUp: https://${domain}`);
  console.log(
    `Check pods: kubectl get pods -A --kubeconfig ${path.relative(repoRoot, kubeconfig)}`,
  );
}

const [command, ...flags] = process.argv.slice(2);
if (command === "up") {
  await up({ withMonitoring: !flags.includes("--no-monitoring") });
} else if (command === "monitoring") {
  preflight({ withMonitoring: true });
  setupMonitoring();
} else {
  console.error("Usage: node scripts/deploy.mjs up [--no-monitoring] | monitoring");
  process.exit(1);
}
