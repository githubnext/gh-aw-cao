const ACTION_GLOBALS = ["core", "github", "context", "exec", "io", "getOctokit"];

export function setActionsGlobals(actions = {}) {
  for (const name of ACTION_GLOBALS) {
    if (actions[name] !== undefined) globalThis[name] = actions[name];
  }
}
