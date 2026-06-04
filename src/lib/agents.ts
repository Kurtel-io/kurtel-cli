// Stubbed agent data. In the real product this comes from the Kurtel cloud API.
// For now it gives the commands something realistic to render.

import { c } from "../ui/colors.js";

export interface Agent {
  id: string;
  task: string;
  repo: string;
  level: "junior" | "mid" | "senior";
  status: "queued" | "running" | "learning" | "done" | "failed";
  progress: number;
  age: string;
}

export const SAMPLE_AGENTS: Agent[] = [
  {
    id: "agent-7f3a",
    task: "Add idempotency keys to billing webhooks",
    repo: "billing-service",
    level: "senior",
    status: "running",
    progress: 82,
    age: "3m",
  },
  {
    id: "agent-2c9d",
    task: "Migrate dashboard to server components",
    repo: "web-dashboard",
    level: "mid",
    status: "learning",
    progress: 46,
    age: "11m",
  },
  {
    id: "agent-b41e",
    task: "Tighten Terraform IAM scopes",
    repo: "infra-terraform",
    level: "junior",
    status: "queued",
    progress: 0,
    age: "30s",
  },
];

export function statusColor(status: Agent["status"]): string {
  switch (status) {
    case "running":
      return c.indigo("● running");
    case "learning":
      return c.cyan("● learning");
    case "queued":
      return c.gray("○ queued");
    case "done":
      return c.green("✔ done");
    case "failed":
      return c.red("✖ failed");
  }
}

export function levelBadge(level: Agent["level"]): string {
  const label = level.toUpperCase();
  if (level === "senior") return c.indigo(label);
  if (level === "mid") return c.ash(label);
  return c.gray(label);
}
