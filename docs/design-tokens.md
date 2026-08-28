# WorkLog Pro — Design Tokens

Single source of truth for the palette/type/spacing decisions from the
[Phase 1 UI/UX audit](ui-ux-audit/README.md)'s "Concrete recommendations."
Both shells (`platform-electron/shell.html`, `platform-web/index.html`)
declare the same `tailwind.config` block in their `<head>` — there's no
build step, so this file (not a compiled CSS file) is the reference to
check against when adding new markup.

## Color

Declared via `tailwind.config.theme.extend.colors` (Tailwind Play CDN
supports a runtime config object — no build step needed):

```js
colors: {
  primary: "#1E3A5F",
  secondary: "#2563EB",
  accent: "#059669",
  destructive: "#DC2626",
}
```

| Token | Hex | Role | Notes |
|---|---|---|---|
| `primary` | `#1E3A5F` | Brand / primary buttons / links / focus rings | Was `indigo-600`. No stock Tailwind shade matches this exactly — a genuine new color. |
| `secondary` | `#2563EB` | Secondary actions | **Identical** to Tailwind's stock `blue-600` — already correct where `blue-*` was already used; no alias needed in most cases. |
| `accent` | `#059669` | Positive / earnings / paid | **Identical** to Tailwind's stock `emerald-600` — already correct everywhere `emerald-*` is used; no migration needed. |
| `destructive` | `#DC2626` | Danger / delete | Was `rose-600` (`#e11d48`, a different hex). Migrated. |

`background` (`#F8FAFC`) and `foreground` (`#0F172A`) are **not** aliased
as custom tokens — they're exact matches for Tailwind's stock
`slate-50`/`slate-900`, which the app already used for the page
background and header/dark-surface color respectively. Adding a
redundant `bg-background`/`text-foreground` alias for a value that
already has a native Tailwind class would only add a second name for
the same thing — use `bg-slate-50` / `text-slate-900` (or `bg-slate-900`
for a dark surface) directly.

### What was migrated, and what deliberately wasn't

Migrated (mechanical, unambiguous, low-risk — all on light backgrounds):
- Every `ring-indigo-500` focus ring → `ring-primary` (every text input in the app)
- Every solid `bg-indigo-600 hover:bg-indigo-700` button fill → `bg-primary hover:bg-primary/90`
- The `bg-indigo-600/10` icon-circle tint → `bg-primary/10`
- The `bg-indigo-600 text-white` toggle-active-state pattern (EN/AR language toggle, sign-up-mode toggle) → `bg-primary text-white`
- Every `rose-*` danger/delete instance → the matching `destructive` token/opacity variant

**Deliberately left as legacy `indigo-*`/`text-indigo-{300,400,500,600,700,800}`, `bg-indigo-{50,100}`, `border-indigo-*`:**
- The header logo icon square and its border (`bg-indigo-600/30`, `border-indigo-500/30`) and the header's light accent text (`text-indigo-400`/`text-indigo-300`, the project-switch link, the live-clock digits) — these sit on the **dark** `bg-slate-900` header. `primary` (`#1E3A5F`) is itself a dark navy; swapping these would put a dark color on a near-black background and badly hurt contrast/visibility. This needs a deliberately chosen *light* accent shade, not a mechanical swap — left as a follow-up, not attempted blind.
- Scattered `text-indigo-600/700/800/500` link/label text and `bg-indigo-50/100` badge tints elsewhere in both files — real "primary" role instances, but numerous and not part of the Phase-2/3 scope (the 5 high-severity audit fixes). Left as a known, disclosed follow-up rather than a blanket sweep with no visual verification budget in this pass.

## Typography

Font: **Public Sans** (Google Fonts), replacing Inter — loaded the same
way Inter was (a `<link>` in `<head>`, applied via `body { font-family }`
in each shell's inline `<style>` block).

Scale: Tailwind's standard steps only — `text-xs` (12px) through
`text-3xl`. Every arbitrary `text-[Npx]` value found in the audit was
collapsed to the nearest standard step:

| Arbitrary value | → | Standard step |
|---|---|---|
| `text-[10px]`, `text-[11px]` | → | `text-xs` (12px) |
| `text-[13px]` | → | `text-sm` (14px) |
| `text-[17px]` | → | `text-lg` (18px) |

No arbitrary text-size values remain in either shell (verified via
`grep "text-\["`).

## Spacing

Formalized rhythm for new/touched markup:

- **Card / section padding:** `p-6` on desktop (`platform-electron`), `p-4` on mobile (`platform-web`)
- **Intra-card gaps** (between related fields/rows inside one card): `gap-3` / `space-y-3`
- **Inter-section gaps** (between distinct cards/sections): `gap-6` / `space-y-6`

Applied to every section touched in the Phase 2/3 implementation pass
(Shift Settings restructure, Create Invoice modal sections, stat tiles).
Not retroactively applied to untouched markup elsewhere in either file —
that would be a much larger, separate sweep outside this pass's scope.

## Motion

A single shared modal-transition treatment (150–200ms opacity/scale) —
see the `.modal-transition` class added to each shell's `<style>` block
and applied to all six modals (Manual Entry, Expense, Create Invoice,
Invoice Preview, Project Picker, Edit Break) instead of six one-off
hand-tuned transitions.
