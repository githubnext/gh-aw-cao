// Package logger provides namespace-based debug logging copied from the gh-aw
// logger package and adapted to use only the Go standard library.
//
// Set DEBUG to a comma-separated list of namespace patterns to enable logs:
//
//	DEBUG=cao:server,cao:query
//	DEBUG=cao:*
//	DEBUG=*,-cao:redis
//
// ACTIONS_RUNNER_DEBUG=true enables all namespaces when DEBUG is unset.
package logger
