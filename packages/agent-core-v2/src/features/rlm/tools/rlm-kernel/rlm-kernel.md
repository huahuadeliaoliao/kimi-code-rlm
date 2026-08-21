Execute Python in the persistent RLM workspace.

Variables, imports, functions, and compact working data remain available across calls. Treat the filesystem as live state: when a result depends on current files, paths, or repository structure, inspect the relevant paths here instead of inferring them from memory, summaries, or an earlier listing. Reuse inspected data while it remains valid, and refresh only paths that may have changed.

`access="inspect"` is the default. It allows read-only Python and blocks file changes, subprocesses, network connections, and mutating task operations. Use `access="work"` only when the cell must change files or start a process. A denied operation is a boundary, not a reason to retry through another route.

Use Python standard-library APIs for file inspection, search, transformation, and focused edits. Run short project commands with `subprocess.run` through the project's own environment; do not install project dependencies into the managed RLM runtime.

Large cell and task output returns a compact preview and an opaque handle. Read or search it with `await rlm.output.read(...)` and `await rlm.output.search(...)` rather than printing it again. `rlm.state()` reports the safe namespace inventory after compaction or recovery. Credentials, live process handles, open files, synchronization objects, heavy framework objects, and oversized values are excluded from automatic checkpoints.

Do not use `subprocess.Popen` or background threads for detached work. Run tests, builds, training, servers, polling, and other long-lived commands with `await rlm.task.run(...)`; control them with `wait(...)`, `list()`, `output(...)`, and `stop(...)`.
