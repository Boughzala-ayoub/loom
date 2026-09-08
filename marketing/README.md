# marketing

The Loom product video, in [Remotion](https://remotion.dev). Separate npm project
so React never lands in the Tauri app's dependencies.

```
npm install
npm run studio    # scrub / edit at http://localhost:3000
npm run render    # → out/loom.mp4  (1920×1080, 30fps, ~43s)
```

`src/ui.tsx` mocks the real app chrome — colours, radii and metrics are copied
from `../src/styles.css`, so the video shows the product as it actually looks.
Change the app's palette and this needs the same change.

`src/Loom.tsx` is the timeline: eight scenes in a `<Series>`, durations at the
bottom of the file. Copy lives in the `Head` of each scene.

No soundtrack and no blip — the "loom blips" beat is carried by the ring
animation alone. Drop an mp3 in `public/` and add `<Audio>` if you want one.

Remotion is free for individuals and companies of ≤3 people; larger companies
need a licence.
