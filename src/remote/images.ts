/** Images for an agent from the phone: pasted from its clipboard, or a photo or file picked or taken. Each
 * waits under its box as a thumbnail you can remove until the message goes. Then it goes up to Loom (POST
 * /api/image, remote.rs), which saves it on the PC and answers its path, and the message carries the paths:
 * Claude Code and Codex open an image from a path in a prompt. */
import { app, el, hooks, iconButton, item, sheet, sleep, store, toast } from "./core";

/** What Loom keeps (remote.rs checks the bytes themselves). */
const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export type Shot = { blob: Blob; url: string };
/** Each box's images, by its key: "prompt:<the agent's draft key>" or "reply:<pane id>". */
const held = new Map<string, Shot[]>();
export const shots = (key: string | null) => (key === null ? [] : held.get(key) ?? []);

export function add(key: string, blobs: Blob[]) {
  const ok = blobs.filter((b) => TYPES.includes(b.type));
  if (ok.length < blobs.length) toast("Loom takes PNG, JPEG, WebP and GIF images.", true);
  if (!ok.length) return;
  held.set(key, [...shots(key), ...ok.map((blob) => ({ blob, url: URL.createObjectURL(blob) }))]);
  paint(key);
}

/** Takes `gone` off the box: removed by hand, or sent. One added meanwhile stays. */
export function drop(key: string, gone: Shot[]) {
  const left = shots(key).filter((s) => !gone.includes(s));
  for (const s of gone) URL.revokeObjectURL(s.url);
  if (left.length) held.set(key, left);
  else held.delete(key);
  paint(key);
}

/** The thumbnails a box shows, each with its ✕. Every tray for the key redraws when they change. */
export function tray(key: string) {
  const box = el("div", "shots");
  box.dataset.key = key;
  fill(box);
  return box;
}
/** A tray that follows another box: the agent screen's, as you go from agent to agent. */
export function retray(box: HTMLElement, key: string) {
  box.dataset.key = key;
  fill(box);
}
function fill(box: HTMLElement) {
  const key = box.dataset.key!;
  box.hidden = !shots(key).length;
  box.replaceChildren(...shots(key).map((s, i) => {
    const shot = el("figure", "shot");
    const img = el("img");
    img.src = s.url;
    img.alt = `Image ${i + 1}`;
    shot.append(img, iconButton("close", `Remove image ${i + 1}`, () => drop(key, [s])));
    return shot;
  }));
}
function paint(key: string) {
  for (const box of document.querySelectorAll<HTMLElement>(".shots")) if (box.dataset.key === key) fill(box);
}

/** The phone's own file chooser: gallery, files, or the camera. */
const picker = el("input");
Object.assign(picker, { type: "file", accept: "image/*", multiple: true, hidden: true }); // image/*: Android offers the camera too
picker.id = "image-pick";
document.body.append(picker);
let pickFor = "";
picker.onchange = () => {
  if (pickFor) add(pickFor, [...(picker.files ?? [])]);
  picker.value = "";
};

/** The box's image button: Paste image, where the browser can read the clipboard, and Photo or file. */
export function imageButton(key: () => string | null) {
  return iconButton("image", "Add an image", () => {
    const k = key();
    if (k === null) return;
    void sheet([
      // Chrome on Android offers no Paste in a text box while the clipboard holds only an image, so the page reads it.
      ...("read" in (navigator.clipboard ?? {}) ? [item("Paste image", () => paste(k), "", { icon: "paste" })] : []),
      item("Photo or file", () => {
        pickFor = k;
        picker.click(); // still in the tap: a chooser opened later is refused
      }, "", { icon: "image" }),
    ], "Add an image");
  });
}

async function paste(key: string) {
  let items: ClipboardItems;
  try {
    items = await navigator.clipboard.read();
  } catch (e) {
    throw new Error(e instanceof DOMException && e.name === "NotAllowedError"
      ? "Loom may not read the clipboard. Allow it in this site's settings, or pick the image with Photo or file."
      : "Couldn't read the clipboard. Pick the image with Photo or file.");
  }
  const blobs: Blob[] = [];
  for (const it of items) {
    const type = it.types.find((t) => t.startsWith("image/"));
    if (type) blobs.push(await it.getType(type));
  }
  if (!blobs.length) throw new Error("The clipboard holds no image.");
  add(key, blobs);
}

/** A paste into the box: its images join the box's, its text goes in as ever. Where the system's Paste does
 * fire with an image (a desktop browser, some keyboards), this takes it. */
export function onPaste(box: HTMLElement, key: () => string | null) {
  box.addEventListener("paste", (e) => {
    const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    const k = key();
    if (!images.length || k === null) return;
    if (!e.clipboardData?.getData("text/plain")) e.preventDefault();
    add(k, images);
  });
}

/** How long one try may take: remote.rs gives an image's body 10 minutes from its first byte (CLIP_TOTAL),
 * so 20 MiB arrives at 0.3 Mbps, and its answer half a minute more. */
const UPLOAD_MS = 630_000;

/** The images to Loom, one after another: their paths on the PC. A connection lost on the way is tried
 * again; an image sent twice is only saved twice. */
export async function upload(list: Shot[]) {
  const paths: string[] = [];
  for (const s of list) {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch("/api/image", {
          method: "POST",
          headers: { Authorization: `Bearer ${app.token}`, "Content-Type": s.blob.type },
          body: s.blob,
          signal: AbortSignal.timeout(UPLOAD_MS),
        });
      } catch {
        if (attempt < 2) { await sleep(1500); continue; }
        throw new Error("Can't reach Loom, so nothing was sent. Is the PC on, and Tailscale connected on both?");
      }
      const reply = await res.json().catch(() => null);
      if (res.status === 401) {
        store("");
        hooks.unpaired();
      }
      if (!reply?.ok) throw new Error(reply?.error ?? `Loom isn't answering (${res.status}).`);
      paths.push(String(reply.path));
      break;
    }
  }
  return paths;
}

/** The message as the agent gets it: what you typed, then each image's path, on one line. */
export const withPaths = (text: string, paths: string[]) => [text, ...paths.map((p) => (/\s/.test(p) ? `"${p}"` : p))].filter(Boolean).join(" ");
