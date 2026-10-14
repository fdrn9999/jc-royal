# Third-Party Notices

JC ROYAL includes or adapts code from the following open-source projects.

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

## Fonts

- Cinzel — SIL Open Font License 1.1 (Google Fonts)
- Pretendard — SIL Open Font License 1.1 (https://github.com/orioncactus/pretendard)
