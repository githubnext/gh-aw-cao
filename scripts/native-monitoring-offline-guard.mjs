import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import dns from "node:dns";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { realpathSync } from "node:fs";

const root = process.env.NATIVE_MONITORING_REPLAY_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error("Explicit clean replay root required");
const deny = () => { throw new Error("Offline native replay prohibits network and external/target execution"); };
const permitted = (command, args) => command === process.execPath && Array.isArray(args)
  && typeof args[0] === "string" && path.resolve(args[0]).startsWith(path.join(root, ".github/skills/add-operational-value/scripts/"))
  && args[0].endsWith(".mjs");
for (const key of ["execFileSync", "spawnSync", "execFile", "spawn"]) {
  const original = childProcess[key];
  childProcess[key] = function(command, args, ...rest) {
    if (command === "shasum" && Array.isArray(args) && args.length === 3 && args[0] === "-a" && args[1] === "256") {
      const file = realpathSync(path.resolve(args[2]));
      if (!file.startsWith(`${root}${path.sep}`)) return deny();
      return original.call(this, "/usr/bin/shasum", ["-a", "256", file], ...rest);
    }
    if (!permitted(command, args)) return deny();
    return original.call(this, command, args, ...rest);
  };
}
for (const key of ["exec", "execSync", "fork"]) childProcess[key] = deny;
globalThis.fetch = deny;
for (const module of [http, https]) for (const key of ["request", "get"]) module[key] = deny;
for (const key of ["connect", "createConnection"]) net[key] = deny;
net.Socket.prototype.connect = deny;
tls.connect = deny;
dgram.createSocket = deny;
for (const key of ["lookup", "resolve", "resolve4", "resolve6"]) dns[key] = deny;
syncBuiltinESMExports();
