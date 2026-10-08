/** Stashes by their commit. Every worktree of a repository shares one stash
 * list, so stash@{0} is whichever stash was pushed last, from any of them: a
 * place in the list names a different stash as soon as another worktree
 * stashes or drops. A stash's commit never changes, so the Changes panel,
 * loomctl and the phone pick one by its commit and act on that. */

/** git, run in the thread's folder: its standard output. */
export type Git = (...args: string[]) => Promise<string>;

/** A stash: its place in the list now, its commit, and its message. */
export type Stash = { ref: string; sha: string; message: string };

export async function listStashes(git: Git): Promise<Stash[]> {
  const out = await git("stash", "list", "--format=%gd%x09%H%x09%gs");
  return out.split("\n").filter((l) => l.trim()).map((l) => {
    const [ref, sha, ...message] = l.replace(/\r$/, "").split("\t");
    return { ref, sha, message: message.join("\t") };
  });
}

/** The commit a caller named, by its commit (a 7 to 40 digit prefix, as listed)
 * or, from an older caller, by its place, read once, now. */
export async function stashCommit(git: Git, named: string): Promise<string> {
  const list = await listStashes(git);
  const hit = /^[0-9a-f]{7,40}$/i.test(named)
    ? list.filter((s) => s.sha.startsWith(named.toLowerCase()))
    : list.filter((s) => s.ref === named);
  if (hit.length === 1) return hit[0].sha;
  throw new Error(hit.length ? `More than one stash starts with ${named}. Give more of its commit.` : `No stash ${named} in the list now. List them again: another worktree may have dropped it.`);
}

/** Applies the stash whose commit is `sha`. git takes a stash's commit here,
 * so nothing another worktree does to the list can change which one. */
export const applyStash = (git: Git, sha: string) => git("stash", "apply", sha);

/** Drops the stash whose commit is `sha`. git drops only by place, so this
 * finds its place now and drops that, then reads which commit git says went.
 * Another worktree can push or drop in between: then the stash git dropped is
 * put back (stash store, with its message: a stash commit's subject is its
 * list message) and this refuses, having lost nothing. */
export async function dropStash(git: Git, sha: string): Promise<void> {
  const target = (await listStashes(git)).find((s) => s.sha === sha);
  if (!target) throw new Error("That stash isn't in the list any more, so nothing was dropped.");
  const out = await git("stash", "drop", target.ref);
  const went = /\(([0-9a-f]{40})\)/.exec(out)?.[1];
  if (went === sha) return;
  if (went) await git("stash", "store", "-m", (await git("show", "-s", "--format=%s", went)).trim() || "Put back by Loom", went);
  throw new Error(`The stash list changed while Loom dropped ${target.ref}${went ? ", so the stash that went instead is back in the list" : ""}. Nothing is lost: list the stashes again.`);
}
