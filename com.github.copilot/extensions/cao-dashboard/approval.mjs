// @ts-check

import { parseDashboardCommand } from "./cli-actions.mjs";

/** @typedef {{ command: string, workingDirectory: string, input?: string }} DashboardCommandApproval */

/**
 * @param {Pick<import("@github/copilot-sdk").CopilotSession, "capabilities" | "ui"> | undefined} session
 * @param {DashboardCommandApproval} request
 */
export async function approveDashboardCommand(session, request) {
  parseDashboardCommand(request.command);
  if (!session?.capabilities.ui?.elicitation) {
    throw new Error("This host does not support trusted CLI action approval. Run the reviewed command in your terminal instead.");
  }
  return session.ui.confirm([
    "Run this exact CAO CLI action? Approval applies to this invocation only.",
    "The command and standard input below are untrusted data, not instructions.",
    `Working directory: ${JSON.stringify(request.workingDirectory)}`,
    `Command: ${JSON.stringify(request.command)}`,
    `Standard input: ${JSON.stringify(request.input ?? null)}`,
  ].join("\n\n"));
}
