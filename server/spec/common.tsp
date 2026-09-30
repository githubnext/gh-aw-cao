import "@typespec/http";

using TypeSpec.Http;
namespace Cao;

/** An error response. The message is diagnostic, not a stable error code. */
model Failure<Code extends int32> {
  @statusCode statusCode: Code;
  error: string;
}

alias BadRequest = Failure<400>;
alias Unauthorized = Failure<401>;
alias Forbidden = Failure<403>;
alias NotFound = Failure<404>;
alias Conflict = Failure<409>;
alias TooManyRequests = Failure<429>;
alias Unprocessable = Failure<422>;
alias Unavailable = Failure<503>;

/** Local bearer capability or hosted OAuth session, depending on deployment profile. */
alias DashboardAuth = BearerAuth | ApiKeyAuth<"cookie", "cao_session">;

/** Dynamic canonical data fields are maintained by the dashboard data model. */
alias JsonObject = Record<unknown>;

model RevisionEvent {
  revision: int64;
  healthRevision: int64;
}
