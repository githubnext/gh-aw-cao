---
title: Value gains
description: Understand the grader-observation count in Overview.
---

Value gains shows how many grader observations are available as evidence of
operational value. Select the count to open Operational value and inspect the
underlying evidence.

Treat the count as an evidence trail, not as a universal score. Its meaning
depends on the operation's grader, value contract, and accepted thresholds.

## Data it uses

`overview-value-summary` counts records in `grader-observations`. The status
header also uses this result when classifying whether the factory is delivering
value.

The component does not estimate money or time saved, and it does not derive a
value claim from run volume alone. When grader evidence is absent or pending,
follow the Operational value view before drawing a conclusion.