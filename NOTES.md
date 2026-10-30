# GazeChat

Fork of [thibautrey/even-messages](https://github.com/thibautrey/even-messages) (Message Lens), rebuilt as a polished messaging app for Even Realities G2 smart glasses.

## Naming decisions
- App name: **GazeChat** (15 chars max rule, no "Even" in name, no brand conflicts — trademark check done Oct 2026: no registered "GazeChat" mark; nearest neighbor is "Gaze – Live Random Video Chat", unrelated class/ecosystem)
- package_id: `com.joewypior.gazechat` (verify free with `evenhub pack -c` before first build)
- Maintainer handle: `wypiki` → planned rename to `builtproper` (manual only: github.com/settings/admin; afterwards update all remotes)

## Planned improvements over upstream
- Text sanitizing (strip markup tags from message bodies)
- Real layout: more lines per message, no clipping, graphical UI instead of plain text
- Thread list with expand/collapse without one-by-one opening
- TTS playback of messages via AirPods (uses local Qwen3-TTS on eGPU: http://192.168.178.43:5001)
- Voice recording/dictation for replies
- Image support, keyboard/foot-pedal input support

## Legal
- Upstream README claims MIT but ships NO LICENSE file. Before publishing: ask author (thibautrey) to add the MIT LICENSE file; keep attribution in About screen regardless.

## Remotes
- `origin`   → https://github.com/wypiki/gazechat (fork, push target)
- `upstream` → https://github.com/thibautrey/even-messages (pull updates via `git fetch upstream && git merge upstream/main`)

## Key upstream files
- `src/GlassesUI.tsx` — ~3400-line monolith, main rewrite target
- `src/speechProvider.ts` — existing TTS/dictation hooks
- Beeper Desktop API: localhost:23373, Bearer token
