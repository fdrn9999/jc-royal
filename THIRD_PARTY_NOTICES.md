# Third-Party Notices

JC ROYAL includes or adapts code and media from the following sources.

## poker-engine-ts — MIT

- Source: https://github.com/Ge-limin/poker-engine-ts (npm `poker-engine-ts@0.1.3`)
- Use: runtime dependency (game rules, event log, settlement). A minimal patch is applied via
  `patches/poker-engine-ts@0.1.3.patch` (see `docs/ENGINE_NOTES.md`).

```
MIT License

Copyright (c) 2026 Limin Ge

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Elite-Poker — MIT

- Source: https://github.com/opadips/Elite-Poker (commit 4e38645)
- Use: UI/UX adapted and rewritten in TypeScript — card face/back layout, chip denomination tiers,
  chip stacks and flying-chip animation, seat layout on an ellipse, player seat structure, timer ring,
  action bar, reveal animations, theme variable system, Web Audio sound synthesis
  (`packages/ui`, `packages/audio`, `apps/web/src/game`).

```
MIT License

Copyright (c) 2026 OpaDips

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.```

## Ai-Poker — not redistributed

- Source: https://github.com/Apoorv-16/Ai-Poker (commit b18bd3c)
- The repository has no LICENSE file (only "MIT" in the README). Because the grant is unclear, **no code
  was copied**; its route layout, table/transaction model and admin feature list were used only as a
  reference for an independent implementation.

## Lucide — ISC (some icons MIT, from Feather)

- Source: https://lucide.dev (npm `lucide-react@1.52.0`)
- Use: runtime dependency for the interface icons (buttons, replay controls, navigation), re-exported by name from
  `packages/ui/src/icons.tsx`. Only the icons named there are bundled. The hand-ranks icon there is Lucide's spade,
  scaled down, beside three lines of our own.
- Some Lucide icons are derived from Feather (MIT, Copyright (c) 2013-present Cole Bemis); the package's LICENSE
  lists them. Among those used here: arrow-down/left/right, check, chevron-down/left/right/up, lock, log-out,
  minus, plus, smile, square, triangle-alert (Feather's alert-triangle), x.

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

```
The MIT License (MIT) (for the icons derived from Feather)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Sound effects — Pixabay Content License

- Source: Pixabay sound effects (https://pixabay.com/service/license-summary/). Attribution is not required;
  it is listed here for provenance.
- Use: `packages/audio/src/sfx/*.mp3`, trimmed, converted to mono, level-matched and re-encoded for the
  table. They are part of the game and are not offered for download on their own.

| File | Title | Author | Page |
| --- | --- | --- | --- |
| `deal.mp3` | Placing playing card | OxidVideos | https://pixabay.com/sound-effects/film-special-effects-placing-playing-card-522514/ |
| `flip.mp3` | Taking playing card - 2 | OxidVideos | https://pixabay.com/sound-effects/film-special-effects-taking-playing-card-2-522516/ |
| `chip.mp3` | Placing poker chips | OxidVideos | https://pixabay.com/sound-effects/film-special-effects-placing-poker-chips-522521/ |
| `call.mp3` | Placing poker chips | OxidVideos | https://pixabay.com/sound-effects/film-special-effects-placing-poker-chips-522515/ |
| `raise.mp3` | Poker chips | OxidVideos | https://pixabay.com/sound-effects/film-special-effects-poker-chips-522517/ |
| `allin.mp3` | AllInPushChips | freesound_community | https://pixabay.com/sound-effects/film-special-effects-allinpushchips-96121/ |
| `fold.mp3` | Playing Cards Throw | freesound_community | https://pixabay.com/sound-effects/household-playing-cards-throw-94502/ |
| `win.mp3` | Handfull of Poker Chips | freesound_community | https://pixabay.com/sound-effects/film-special-effects-handfull-of-poker-chips-95810/ |

## Fonts

- Cinzel — SIL Open Font License 1.1 (Google Fonts)
- Pretendard — SIL Open Font License 1.1 (https://github.com/orioncactus/pretendard)
