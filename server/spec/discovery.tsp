import "@typespec/http";

using TypeSpec.Http;
namespace Cao;

@example("# Central Agentic Ops dashboard server\n\nServer commit SHA: unknown\n")
scalar AgentGuideText extends string;

model AgentGuideHeaders {
  @header contentType: "text/plain; charset=utf-8";
  @header("Cache-Control") cacheControl: "no-store";
}

model AgentGuideResponse {
  ...AgentGuideHeaders;
  @statusCode code: 200;

  @body
  body: AgentGuideText;
}

model AgentGuideHeadResponse {
  ...AgentGuideHeaders;
  @statusCode code: 200;
}

@tag("Agent discovery")
namespace Discovery {
  /**
   * Public in local and hosted profiles, without a bearer capability or OAuth
   * session. Returns the server's agent guide, documentation links and build
   * commit SHA (or "unknown"). The guide describes MCP availability but does not
   * enable the optional MCP endpoint. Hosted requests are limited per client
   * address; an externally hosted handler returns 503 before startup or after
   * shutdown.
   */
  @route("/llms.txt")
  @get
  op agentGuide(): AgentGuideResponse | TooManyRequests | Unavailable;

  /** Same public access and success headers as GET /llms.txt, without a response body. */
  @route("/llms.txt")
  @head
  op agentGuideHeaders():
    | AgentGuideHeadResponse
    | {
        @statusCode code: 429 | 503;
      };
}
