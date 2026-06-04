# Notification Accountability Mockup

## Goal

Show Dryft as an AI accountability coach that watches bank-connected spending against a user-approved plan and catches drift before it becomes a real problem. The phone should read like a real iPhone 15 Pro lock screen, not a screenshot mock.

This mockup should make a student feel: "I do not need another dashboard. I need something to catch me in the moment."

## Device Frame

- iPhone 15 Pro style, custom-built (no external `devices.css` dependency).
- Titanium-look outer shell: layered linear gradient with brushed-metal stops.
- Dual inner ring shadows for screen recess + outer drop shadow for 3D pop.
- Dynamic Island pill (92x26) with realistic camera lens (radial gradient lens + iris glint).
- Side rails:
  - Left: Action button, Volume Up, Volume Down.
  - Right: Power button.
- Subtle screen reflection layer (`screen` blend mode) for glass realism.
- Phone is rotated `rotateY(8deg) rotateZ(-4deg)` and floats gently (9s ease loop).

## Lock Screen Layout

Top to bottom:

1. Dynamic Island.
2. Status bar: `9:41` left, signal bars + wifi + battery right (real SVG icons).
3. Date `Wednesday, May 20`.
4. Massive time `9:41` (DM Sans, 200 weight, slight text-shadow).
5. Glass weather pill: `Waterloo · 18° Partly cloudy`.
6. Notification Center separator label.
7. **Notification stack** anchored to bottom-above-home-indicator.
8. Bottom row: flashlight icon, home indicator bar, camera icon.

## Notification Animation (Bottom-Up Cascade)

This is the core motion of the phone:

- Notifications enter from the **bottom** of the stack (slide up from below + scale 0.94 -> 1, 550ms).
- Each new arrival **pushes prior notifications upward** in opacity/scale tiers:
  - Newest (bottom): full opacity, scale 1.
  - One up: opacity 0.88, scale 0.97.
  - Two up: opacity 0.68, scale 0.94.
  - Three up: opacity 0, translateY -6px, scale 0.9 (fades out the top).
- Cadence: a new notification every 2.4s.
- Sequence repeats forever; DOM is trimmed after fade-out.

## Notification Content

Four-message rotation (JS-driven, looping):

```text
Dryft · now
"Dining drift detected. You're 6 days ahead of plan.
 Skip one delivery, rent week stays safe."
[Drift] +$112 over pace

Dryft · 2m ago
"Netflix and Equinox renew before rent.
 Want a safer cashflow path?"
[Cashflow] Action needed

Dryft · 14m ago
"Coach mode: direct. Course-correct today,
 not at month-end. One $64 move fixes it."
[Coach] Suggested move

Dryft · just now
"Plan is back on track.
 Savings buffer secured for May."
[On plan] Good morning ☀
```

Each notification carries a small colored `tag` chip (warn/coach/ok) plus a one-line meta indicator beneath the body.

## Visual Style

- Background: rich warm gradient (gold + red + green radial glows over near-black).
- Cards: `backdrop-filter: blur(24px) saturate(1.4)`, true iOS-style frosted glass.
- App icon: Playfair `D` in gold inside a 5px-radius dark tile with gold inset ring + glow.
- Body text: 0.62rem, 1.32 line-height, near-white.
- Tag chips reuse the accent palette (gold for default, red for drift, green for on-plan).

## Why This Works

Students do not want to inspect budgets. They want to know whether they are still okay. This mockup turns Dryft into an ambient accountability layer, it notices the dangerous moment, explains why it matters, and ends with a green "Plan back on track" beat so the emotional arc completes.

```text
I thought I was fine -> Dryft caught the drift -> I see the move -> rent week is protected
```

## Reduced Motion

`prefers-reduced-motion: reduce` short-circuits the JS engine and renders three notifications statically in their final stacked positions. No animation, no looping.

## Implementation Notes

- Notification engine lives in `assets/js/main.js` (`runNotificationLoop`).
- DOM nodes are recycled (max 4 in flight) to keep memory flat.
- Animation is fully driven by CSS transitions toggled via class state, no JS frame loop.
- Phone floats with a tiny `notifPhoneFloat` keyframe (6px vertical breathe over 9s) for life.
