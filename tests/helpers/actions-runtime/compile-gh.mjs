#!/usr/bin/env node
// The real compiler invokes `gh run list` for its mandatory dry-run model check.
// A fresh synthetic repository has no historical runs. Reject every other call.
if (process.argv[2] === "run" && process.argv[3] === "list") {
  process.stdout.write("[]\n");
} else {
  process.stderr.write("Unsupported compiler GitHub fixture request\n");
  process.exitCode = 1;
}
