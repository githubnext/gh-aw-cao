import "@typespec/http";
import "@typespec/openapi3";
import "@typespec/openapi";
import "@typespec/json-schema";
import "./common.tsp";
import "./query.tsp";
import "./health.tsp";
import "./discovery.tsp";
import "./auth.tsp";
import "./canonical.tsp";
import "./github.tsp";
import "./memory.tsp";
import "./operations.tsp";
import "./mcp.tsp";
import "./local.tsp";

using TypeSpec.Http;
using TypeSpec.OpenAPI;

@service(#{ title: "CAO dashboard server" })
@info(#{ version: "2.7.0" })
@doc("The Go dashboard server HTTP contract. SQLite previews mount these paths under a random per-process capability prefix and require same-origin JSON mutations. The TLS local profile uses a loopback bearer capability; hosted mode uses an authorized GitHub OAuth session and X-CSRF-Token on protected mutations. Local preview authoring and CLI operations do not exist in hosted deployments. The optional MCP HTTP transport is covered, but its protocol messages and tool schemas are owned by the MCP contract; dashboard static assets and preview live-reload WebSockets are outside this contract.")
namespace Cao;
