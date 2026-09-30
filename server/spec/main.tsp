import "@typespec/http";
import "@typespec/openapi3";
import "@typespec/json-schema";
import "./common.tsp";
import "./query.tsp";
import "./health.tsp";
import "./auth.tsp";
import "./canonical.tsp";
import "./memory.tsp";
import "./operations.tsp";

using TypeSpec.Http;

@service(#{ title: "CAO dashboard server", version: "1.0.0" })
@info(#{ description: "The Go dashboard server HTTP contract. Local mode uses a loopback bearer capability; hosted mode uses an authorized GitHub OAuth session and X-CSRF-Token on mutations. Routes available only in a configured profile are marked in their operation descriptions. MCP and dashboard static assets are outside this contract." })
namespace Cao;
