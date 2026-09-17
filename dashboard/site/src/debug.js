// Compatibility re-export: the implementation lives in debug.mjs. Existing
// imports of './debug.js' (and '../debug.js') keep working unchanged.
export {
  createDebug,
  debugShardLimit,
  fullDebugUrl,
  isDebugEnabled,
  withDebugParameter
} from './debug.mjs';
