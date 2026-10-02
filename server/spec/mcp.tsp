import "@typespec/http";

using TypeSpec.Http;
namespace Cao;

@tag("MCP transport")
namespace Mcp {
  /** Optional stateless streamable HTTP transport, present only when MCP is enabled. Local mode accepts the dashboard bearer capability or a configured GitHub Actions identity; hosted mode requires a repository-scoped GitHub Actions identity (bearer token, actor and signed OIDC token). MCP message formats and tool schemas are maintained by the MCP contract, not this HTTP contract. */
  @useAuth(BearerAuth)
  @route("/mcp")
  @post op exchange(
    @header("X-GitHub-Actor") githubActor?: string,
    @header("X-GitHub-OIDC-Token") githubOIDCToken?: string,
    @header("MCP-Protocol-Version") protocolVersion?: string,
    @body message: JsonObject
  ): { @header contentType: "application/json"; @body body: JsonObject } |
    { @statusCode code: 202 } | BadRequest | Unauthorized | Forbidden | NotFound | TooManyRequests | Unavailable;
}
