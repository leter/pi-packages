# Model lifecycle, attention, and outcome separately

A dispatch has a small primary lifecycle (`proposed → delivering → active → settled`), an independent set of concurrent attention conditions, and an optional terminal outcome. A single expanded status enum was rejected because conditions such as overdue and monitoring-paused can coexist, creating a combinatorial state space and causing one operational fact to overwrite another.
