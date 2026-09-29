/** Keep nearby blocks in the DOM. Measured block heights preserve wrapped
 * lines when they leave the viewport; small lists keep ordinary DOM selection. */
export function renderRows(parent: HTMLElement, viewport: HTMLElement, count: number, height: number, row: (i: number) => HTMLElement): () => void {
  if (count <= 500) {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < count; i++) fragment.append(row(i));
    parent.append(fragment);
    return () => {};
  }
  const SIZE = 100;
  const blocks: HTMLElement[] = [];
  const anchor = viewport.style.overflowAnchor;
  viewport.style.overflowAnchor = "none";
  // Keep the same place within the visible block when wrapped rows acquire
  // their real height. Native scroll anchoring loses rows that get replaced.
  const changeHeights = (targets: HTMLElement[], change: () => void) => {
    if (!targets.length) return;
    const edge = viewport.getBoundingClientRect().top;
    const before = targets.map(block => block.getBoundingClientRect());
    const scroll = viewport.scrollTop;
    change();
    const heights = targets.map(block => block.getBoundingClientRect().height);
    let shift = 0;
    targets.forEach((block, i) => {
      const old = before[i];
      const above = old.height ? Math.max(0, Math.min(1, (edge - old.top) / old.height)) : 0;
      shift += (heights[i] - old.height) * above;
      block.style.height = `${heights[i]}px`;
    });
    viewport.scrollTop = scroll + shift;
  };
  const fill = (block: HTMLElement) => {
    if (block.childElementCount) return;
    const start = Number(block.dataset.start);
    const fragment = document.createDocumentFragment();
    for (let i = start; i < Math.min(count, start + SIZE); i++) fragment.append(row(i));
    block.style.height = "";
    block.removeAttribute("aria-hidden");
    block.append(fragment);
  };
  const observer = new IntersectionObserver(entries => {
    const nearby: HTMLElement[] = [];
    for (const { target, isIntersecting } of entries) {
      const block = target as HTMLElement;
      if (isIntersecting && !block.childElementCount) nearby.push(block);
      else if (block.childElementCount) {
        if (isIntersecting) continue;
        const selection = getSelection();
        // Scrolling must not remove a focused action or selected text.
        const selected = selection && !selection.isCollapsed && selection.rangeCount && selection.getRangeAt(0).intersectsNode(block);
        if (block.contains(document.activeElement) || selected) continue;
        block.replaceChildren();
        block.setAttribute("aria-hidden", "true");
      }
    }
    changeHeights(nearby, () => nearby.forEach(fill));
  }, { root: viewport, rootMargin: "400px 0px" });
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < count; i += SIZE) {
    const block = document.createElement("div");
    block.className = "row-block";
    block.dataset.start = String(i);
    block.style.height = `${Math.min(SIZE, count - i) * height}px`;
    block.setAttribute("aria-hidden", "true");
    blocks.push(block);
    fragment.append(block);
    observer.observe(block);
  }
  parent.append(fragment);
  let width = viewport.clientWidth;
  const resize = new ResizeObserver(() => {
    if (!viewport.clientWidth || width === viewport.clientWidth) return;
    width = viewport.clientWidth;
    // ponytail: unseen blocks use one line per row. Wrapping makes the scroll
    // range grow as blocks are visited; measure all text only if that matters.
    changeHeights(blocks, () => {
      for (const block of blocks) block.style.height = block.childElementCount ? ""
        : `${Math.min(SIZE, count - Number(block.dataset.start)) * height}px`;
    });
  });
  resize.observe(viewport);
  return () => { observer.disconnect(); resize.disconnect(); viewport.style.overflowAnchor = anchor; };
}
