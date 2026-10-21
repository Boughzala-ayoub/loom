# Ash listening, re-review of 83804d2..f95fa46

The re-review confirmed that the three original reproductions now pass. It
found one remaining correctness bug in the wrapping fix, which Ayoub asked to
have fixed.

## [P2] A wrapped wide character adds a space to the request

`bufferLines` (`src/pane_events.ts`) joins a row xterm wrapped onto the line
above it, reading each row with `translateToString(false)`. When a
double-width character can't fit in the last column, xterm moves it to the
next row and leaves that last cell empty: `getChars()` is `''`, `getCode()`
is 0 and `getWidth()` is 1. `translateToString(false)` prints the empty cell
as a space, so the joined request gets a space that was never printed.

Reproduced with the installed `@xterm/xterm`: at 39 columns, write
`  @ash: inspect /srv/` followed by 17 `a` characters and `界.log`. The
request comes out with a space between the `a` characters and `界`, so Ash
is sent the wrong filename. After a resize to 90 columns the same request
reads without the space. The deduplication key ignores spaces, which is why
no second send happens, but the text Ash gets is still wrong.

The fix should drop only that empty padding cell when joining a wrapped row.
A space actually printed in the last column must stay, and rows must not be
trimmed in general, which would run separate words together. The indent rule
for agent wraps, the divider guard, Grok's unjoined rows and the three earlier
fixes must keep working.
