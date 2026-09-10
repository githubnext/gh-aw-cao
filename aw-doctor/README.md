# AW Doctor

AW Doctor coordinates organization-wide maintenance of installed GitHub Agentic Workflows. Its workers pre-categorize CI failures, escalate only P0 failures for deep investigation, and run the complete gh-aw compiler validation and security suite against one policy-authorized target repository.

The compiler-security worker reports actionable findings and registers an operational-value evaluator that measures whether the exact target revision attains a complete, clean scan. The package dashboard presents that evidence alongside failure-recovery attainment without treating incomplete evidence as zero.
