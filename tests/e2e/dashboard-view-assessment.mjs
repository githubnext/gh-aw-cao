export function isExpectedPageCloseAbort(errorText, closing) {
  return closing && errorText === "net::ERR_ABORTED";
}
