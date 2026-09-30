import "@typespec/http";

using TypeSpec.Http;
namespace Cao;

model MemoryFile {
  path: string;
  oid: string;
  sha256?: string;
  size: int64;
}
model MemoryOmissions {
  fileLimit: int32;
  fileSize: int32;
  totalSize: int32;
  extension: int32;
  nesting: int32;
  unsafePath: int32;
  invalidContent: int32;
  unsupportedType: int32;
}
model MemoryCampaign {
  campaign: string;
  branch: string;
  commit: string;
  files: MemoryFile[];
  omitted: MemoryOmissions;
}

@tag("Repository memory")
@useAuth(DashboardAuth)
namespace Memory {
  /** Returns JSON null when no campaign exists. Campaign identifiers must meet the repository-memory identifier policy. */
  @route("/api/v1/memory/{campaign}")
  @get op campaign(@path campaign: string):
    { @body body: MemoryCampaign | null } | BadRequest | Unauthorized | TooManyRequests | Unavailable;

  /** Returns verified file content as a JSON string. Relative file paths only; traversal is rejected. */
  @route("/api/v1/memory/{campaign}/content")
  @get op content(@path campaign: string, @query path: string):
    { content: string } | BadRequest | Unauthorized | NotFound | TooManyRequests | Unavailable;
}
