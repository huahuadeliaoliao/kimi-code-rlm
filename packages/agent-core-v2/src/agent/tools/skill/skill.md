Load instructions for a skill from the current skill listing. When the current request clearly matches a listed skill, call this tool before doing the governed work.

Do not reload a skill when a `<skill-loaded>` block with the same `args` is already present; follow that block directly. Call it again when different arguments are needed because argument expansion is specific to each load.
