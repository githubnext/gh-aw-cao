// @ts-check

import { callOperator } from "./operator.mjs";

/** @typedef {{ command: string, workingDirectory: string, input?: string }} DashboardCommandApproval */

/**
 * Validate the invocation already approved in the canvas without a second host prompt.
 * @param {DashboardCommandApproval} request
 */
export async function approveDashboardCommand(request) {
  await callOperator(["dashboard", "action", "--validate", "--command", request.command], "");
  return true;
}
