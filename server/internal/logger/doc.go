// Package logger provides namespace-based debug logging copied from
// github/gh-aw/pkg/logger at e6374a3 and adapted to use only the Go standard
// library.
//
// Set DEBUG to a comma-separated list of namespace patterns to enable logs:
//
//	DEBUG=cao:server,cao:query
//	DEBUG=cao:*
//	DEBUG=*,-cao:redis
//
// ACTIONS_RUNNER_DEBUG=true enables all namespaces when DEBUG is unset.
package logger
