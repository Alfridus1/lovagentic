Add global customer search.

1. Keyboard shortcut `⌘K` (Mac) / `Ctrl+K` (Win/Linux) opens a command-palette-style search modal from anywhere.
2. Search matches against customer name, company, and email. Fuzzy, case-insensitive.
3. Keyboard navigation in the modal: ↑/↓ to move, Enter to open the customer detail drawer, Esc to close.
4. Also add a visible search input in the top nav that opens the same modal on click.
5. Results: max 8 shown at once, with company logo initials on the left (tasteful colored circle), customer name bold, company and status subtle underneath.
6. Empty state inside the modal when nothing matches: "No customers match '…' — start typing something else, or add a new customer."
7. Prefetch / memoize the search index so typing feels instant even with 500+ seeded customers (bump seed to 500 for this).

Keep styling consistent with the rest of the app. Animate the modal with a gentle fade+scale. Respect `prefers-reduced-motion`.
