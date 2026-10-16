// @ts-check

import { parseDashboardCommand } from "./cli-actions.mjs";

/** @typedef {{ command: string, workingDirectory: string, input?: string }} DashboardCommandApproval */

/**
 * Validate the invocation already approved in the canvas without a second host prompt.
 * @param {DashboardCommandApproval} request
 */
export async function approveDashboardCommand(request) {
  parseDashboardCommand(request.command);
  return true;
}
