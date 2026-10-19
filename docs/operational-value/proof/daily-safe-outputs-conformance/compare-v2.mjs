import { compare } from "./native-checker.mjs";

export function compareSurviving(before, after, missingIds) {
  const result = compare(before.assessment, after.assessment);
  const excludedNonSurviving = [];
  result.remediated = result.remediated.filter(row => {
    const start = before.paths[row.file], end = after.paths[row.file];
    const accepted = Boolean(start?.id && end?.id && !missingIds.has(start.id) && !missingIds.has(end.id));
    if (!accepted) excludedNonSurviving.push(row.id);
    return accepted;
  });
  return { ...result, excludedNonSurviving };
}
