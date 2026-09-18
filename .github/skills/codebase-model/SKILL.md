---
name: codebase-model
description: "Compile a human-oriented ARCHITECTURE.md into a compact, machine-readable CODEBASE.yml that preserves architectural constraints, boundaries, relationships, generation guidance, and validation commands."
argument-hint: "Describe the repository or architecture document to compile"
---

# Codebase Model

Create or refresh the experimental `CODEBASE.yml` Codebase Model from an existing
`ARCHITECTURE.md`. Codebase Model is an open, machine-readable model of what a
codebase is: its architecture, constraints, relationships, and operational
context. It is not another agent-instruction format.

`ARCHITECTURE.md` remains the human-oriented source for v0.1. `AGENTS.md`,
`CLAUDE.md`, and vendor-specific instructions are future output targets, not the
canonical model.

## Procedure

1. Read `ARCHITECTURE.md`, relevant repository structure, existing
   `CODEBASE.yml`, and any normative specifications it names.
2. Extract architectural concepts into `spec: cbm/v0.1` with the applicable
   categories: `project`, `structure`, `architecture`, `components`,
   `dependencies`, `boundaries`, `invariants`, `flows`, `generation`,
   `commands`, and `validation`.
3. Preserve dependency direction, prohibited relationships, source-of-truth
   locations, generated-artifact rules, operational flows, validation commands,
   and implementation-affecting decisions. When uncertain whether material is a
   constraint, preserve it.
4. Compress history, motivation, diagrams, repeated examples, conversational
   prose, README duplication, and leaf-file inventories. Do not remove a
   constraint merely because it is verbose.
5. Use meaningful directories and components rather than indexing every file.
   Do not invent architecture, paths, commands, relationships, or constraints
   unsupported by the repository.
6. Encode allowed and prohibited dependencies explicitly. Use `invariants` for
   mandatory rules and execution-location constraints, not punctuation intended
   to influence model behavior.
7. Include `provenance` stating that the model is experimental and naming its
   source. Document intentionally compressed material.
8. Include a `benchmark` hypothesis comparing no architecture context, full
   `ARCHITECTURE.md`, and `CODEBASE.yml`. Measure task completion, architectural
   and dependency violations, incorrect placement, test failures, token usage,
   tool calls, and time. Treat the result as a hypothesis, not an adoption or
   model-obedience claim.
9. Validate that YAML parses, required applicable categories are present,
   command references resolve, declared paths exist or are clearly templates,
   and relationships reference known concepts. Compare the model's size with
   `ARCHITECTURE.md`, favoring semantic fidelity over minimum size.

## Required Constraints

- Keep `CODEBASE.yml` at the repository root unless existing architecture
  requires another location.
- Preserve `ARCHITECTURE.md`; never overwrite it from the model.
- Keep the model canonical and vendor-neutral. Do not make `AGENTS.md` its
  specification or claim universal agent compatibility before adapters exist.
- Do not build a full static architecture analyzer, universal understanding
  system, new language, or campaign-management system for v0.1.
- Do not claim that special punctuation improves AI compliance without evidence.
