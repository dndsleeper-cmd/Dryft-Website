# Chatbot Plan Impact Mockup

## Goal

Show Dryft as a conversational coach that can answer real student money questions, update the plan conversationally, and render a visual "Plan impact" artifact generated from the conversation — not a static dashboard.

This mockup should make a student feel: "I can ask this thing the awkward money question I would normally avoid."

## Device Frame

Same custom iPhone 15 Pro shell as the notification mockup, mirrored:

- Rotated `rotateY(-8deg) rotateZ(4deg)`.
- Floats with a slightly offset 9s loop so the two phones breathe out of phase.
- Sits to the right of the notification phone, lightly overlapping (~30px) at the lower-middle of the stage.

## Chat App Layout

Top to bottom:

1. Dynamic Island + status bar (same as lock).
2. **Chat nav bar** (frosted): back chevron, gold `D` avatar with `Dryft`, live `· bank-connected` indicator (green pulsing dot), `⋯` menu.
3. **Chat feed**: bottom-anchored, items push upward and clip cleanly past the top.
4. **Input bar** (frosted pill): `+` attach button, single-line input with blinking gold cursor, send button (lights up when armed).
5. Home indicator bar.

## Animation Timeline (per loop)

The chat starts ~0.9s after the notification phone so it lags slightly — both phones can run at once with only the lightest overlap.

**Sequence 1 — short answer:**

1. Cursor blinks in empty input bar (placeholder `Ask your plan…`).
2. Text types into input character-by-character with humanized jitter: `Can I buy a PS4 this month?`
3. Send button lights up (gold gradient + glow + 5% scale).
4. Send fires: input clears, user bubble (gold gradient) slides up into the feed.
5. Thinking pill appears: `Checking your May plan` + three staggered bouncing dots.
6. After ~1.1s the thinking pill fades.
7. Dryft response streams character-by-character with per-char fade-in: `Yes — if dining stays under $42/wk and you pause one renewal.`
8. Brief hold.

**Sequence 2 — full diagnostic with graph:**

1. Cursor returns. User types `Why did food spike?`
2. Send. User bubble appears.
3. Thinking: `Finding the pattern` (~1.3s).
4. Streamed answer: `Takeout is up 38% vs last month. Two delivery apps drove it.`
5. **Plan Impact card** slides up — frosted, gold-bordered:
   - Header: `Plan impact · May | vs target`
   - 5 vertical bars (Rent / Food / Subs / Gas / Save) fill staggered from 0 height to their target (`110ms` stagger).
   - Food bar uses red gradient (over plan). Save bar uses green (on track).
   - `Move $64 → Bills` chip fades in 500ms after the card appears.
6. Streamed follow-up: `Move $64 into bills now and cap delivery this week — plan stays green.`
7. Hold ~2.4s.

**Reset:**

- Feed fades out top-down (60ms stagger per item).
- 400ms pause, then sequence restarts from Sequence 1.

## Visual Style

- User bubble: gold-on-gold linear gradient pill with subtle glow, dark text — feels "premium card" not "generic blue iOS".
- Dryft bubble: frosted glass with hairline border + bottom-left-flat corner for direction.
- Thinking pill: same glass as Dryft bubble, dots in `--accent` with vertical bounce.
- Impact card: blurred glass with `--accent` 22% border, soft shadow, slight inset ring.
- Bars use gradient fills (accent → accent2) and animate via plain `height` transition.

## Why This Works

The chat must not feel like a generic AI assistant. The student sees Dryft pulling from their approved plan, recurring charges, and goal — and producing an artifact generated from the conversation, not retrieved from a screen elsewhere.

```text
Can I still do this? -> Dryft checks my reality -> Direct answer ->
I see the impact -> I know the exact next move
```

## Reduced Motion

In `prefers-reduced-motion: reduce`, the engine renders one user bubble + one Dryft response + one fully-filled Plan Impact card. No typing, no streaming, no thinking pill.

## Implementation Notes

- Sequence engine lives in `assets/js/main.js` (`runChatLoop`).
- `streamBubble` adds each character as a `<span class="stream-char">` so per-char fade-in animates via CSS keyframe.
- `typeInto` writes into the input bar with `(0.7 + Math.random() * 0.6)` jitter and a soft pause on spaces — feels like a human, not a metronome.
- Send button glow is class-toggled, not animated through key states.
- Impact card bars use `dataset.h` for target heights so future copy changes don't require touching JS.
- Loop never blocks the main thread — async/await with `setTimeout`-backed `wait()`.
