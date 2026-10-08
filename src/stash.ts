/** Stashes by their commit. Every worktree of a repository shares one stash
 * list, so stash@{0} is whichever stash was pushed last, from any of them: a
 * place in the list names a different stash as soon as another worktree
 * stashes or drops. A stash's commit never changes, so the Changes panel,
 * loomctl and the phone pick one by its commit and act on that: applyStash
 * here, and a drop through stash_drop (src-tauri/src/stash.rs), which holds
 * git's lock on the list while it takes that commit out. git drops only by
 * place, worked out before it takes that lock. */

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
