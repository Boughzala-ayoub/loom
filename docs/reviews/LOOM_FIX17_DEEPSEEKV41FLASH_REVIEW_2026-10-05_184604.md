MUST-FIX: 0

No must-fix findings, safe to install.

What I checked (source, plus one executed harness that ran the real `receiveAgentBatch`/`routeAgentBatches` from `src/main.ts` in a VM over late-base, hole, reverse, 64-cap and close-force sequences; every batch present routed exactly once, in order):

- Reload handshake: `Reports::send` emits under the mutex and only then advances `emitted` (lib.rs:1013), so `agent_batch_base` (lib.rs:1621) cannot return a number below an in-flight batch, and the listener registers before the query (main.ts:9164). Second close forces `routeAgentBatches(shut.emitted)`, then routes final events, sweeps, drains the journal and destroys (main.ts:8885-8895); every wait is 3 s, so no close can hang.
- Record replace: the caller's handle is held across the tmp rename, the new handle is opened before it and becomes `*file` (deletion.rs:124-130), so purge/resume/prepare cannot open a record mid-replace. `.json.tmp` is filtered out of every scan, and a failed reservation removes the record, the Git lock and the ref before anything moves (deletion.rs:256-267).
- Restore removal: no `restoring`, `deletion::restore` or `trash_restore` left in Rust or the CLI; serde ignores the unknown field on old manifests; `trash list`, `resume` and `purge` each handle a damaged or busy record without stopping other work.
- Ref: `keep_ref` escapes every byte, is injective and always yields a valid ref name; it is created before the first move and deleted only on erase, hand-restore cancel, or a failed move; an `update-ref` failure aborts with nothing moved.
- One limit I checked and did not count, since it needs a crash plus a stale saved workspace (the thread is removed before the native call): a pending record completed by `resume` gets no new keep ref (deletion.rs:213, 132-158). A deletion this build starts has the ref in place before it moves anything.
