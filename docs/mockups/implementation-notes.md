# Mockup Implementation Notes

## Hero Composition

Two custom iPhone 15 Pro mockups, side-by-side at a slight 3D tilt:

- **Left**: notification phone (lock screen, bottom-up notification cascade).
- **Right**: chat phone (live conversation with streamed answers + generated impact graph).

The phones overlap by roughly 30px in the middle of the stage. Each tilts toward the other (`rotateY(±8deg)` + `rotateZ(±4deg)`) and breathes on a 9s float loop, offset 0.4s so they never sync.

Together the demo communicates:

```text
Dryft watches real spending  ->  catches drift early  ->
explains the risk  ->  helps adjust conversationally  ->
shows the exact next move
```

## Asset Structure

```text
index.html
assets/css/styles.css   -> all phone + scene styling
assets/js/main.js       -> nav, reveals, waitlist, phone demo engines
docs/mockups/           -> spec docs for each phone
```

No external device-frame dependency (`devices.css` removed). The phone shells are pure CSS so they can rotate, float, and host live content without any image asset.

## Phone Build Recipe

If iterating on the frame:

- Outer shell: `linear-gradient(155deg, ...)` with 5 stops for brushed titanium look.
- 3 nested shadows: outer drop, ambient glow, two inset rings (outer rim + bezel).
- Screen recess: 7px padding around the inner screen, `border-radius: 43px` inside `50px` outer.
- Dynamic Island: absolutely positioned 92x26 black pill, camera dot uses a radial gradient lens + offset iris highlight.
- Side rails (`.phone-rail`): thin 4px columns with absolute-positioned button bars; left has action + vol up + vol down, right has power.
- Screen glass reflection: `::after` overlay with diagonal gradient + `mix-blend-mode: screen`.

## Animation Engines

### Notifications (bottom-up cascade)

- JS loop in `runNotificationLoop`.
- Append new notification, animate `transform: translateY(60px) scale(0.94) -> 0/1` over 550ms.
- Promote prior notifications by adding `.up-1`, `.up-2`, `.up-3` classes (opacity + scale tiers).
- Trim DOM after items fade out the top.
- Cadence: 2400ms between arrivals.

### Chat scene

- JS loop in `runChatLoop`.
- Two sequences per cycle:
  1. PS4 question → short streamed answer.
  2. Food spike question → streamed answer + generated bar graph + streamed follow-up.
- Typing in the input bar uses humanized character jitter (`0.7-1.3x` base speed, longer on spaces).
- Response streaming creates one `<span>` per character so each character can fade in independently via CSS keyframe.
- Send button is a real DOM element that toggles a `.active` class — glow is CSS.
- Bars in the impact card animate via `height` transition on staggered timeouts (110ms each).

## Sync Strategy

- Notification phone starts immediately, leads by ~0.9s.
- Chat phone starts ~0.9s in so the user's eye reaches the second phone after the first alert has landed.
- Both phones run on independent JS loops — no shared timeline. Slight desync is fine and feels alive.
- Total visible "story" is roughly 22-26s before a soft fade-reset.

## Review Checklist

- Can a student understand the product in under 5 seconds?
- Does the notification cascade feel like accountability instead of shame?
- Does the chat show a real answer, not vague AI copy?
- Does the impact card feel **generated from the conversation**, not retrieved?
- Is every word readable inside the phone on desktop and mobile?
- Does the hero still feel premium with both phones active at once?
- Does reduced-motion show a clean final-state version of both?
