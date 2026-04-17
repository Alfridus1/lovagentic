Add polish and accessibility:

1. **Dark mode** — toggle in the top-right user menu, persist via localStorage, respect `prefers-color-scheme` on first load. Use Tailwind's `dark:` variants throughout.

2. **Accessibility**:
   - Every interactive element must have an accessible name (`aria-label` where no visible label exists).
   - Keyboard navigation on the kanban board: `Tab` to focus a card, `Enter` to pick it up, arrow keys to move between columns, `Enter` again to drop.
   - Color contrast: ensure every text-on-background combination meets WCAG AA (4.5:1 body, 3:1 large text).
   - Focus rings are visible and consistent (use the accent color).
   - All status pills and kanban columns include a leading icon, not color alone, to convey state.

3. **Empty states** — customer list, deals board, and report pages each need a proper empty state illustration and CTA when there's no data. Use lucide-react icons.

4. **Micro-interactions** — subtle motion on: row hover, kanban card drag, drawer open/close, tab switch. Keep them under 200ms, easing `ease-out`. Respect `prefers-reduced-motion`.

Nothing else. Don't add new features.
