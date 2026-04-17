Build a CRM Dashboard for a small B2B services business (≤ 50 customers).

**Core features**
- Top navigation: Dashboard · Customers · Deals · Reports · Settings
- Dashboard landing page with four KPI cards: Active Customers, Open Deals, MRR, Churn Rate (use dummy numbers, tasteful).
- Customers list page with table view: name, company, status (Lead/Prospect/Customer/Churned), last contact date, owner avatar.
- Customer detail drawer: contact info, deal history, notes, "Log Activity" button (no backend, just UI state).
- Deals kanban board with four columns: New · Qualified · Proposal · Won. Drag-and-drop (react-beautiful-dnd or @hello-pangea/dnd).

**Design system**
- Clean, modern B2B aesthetic. Think Linear / Notion / Stripe — not Salesforce.
- Inter or Geist for body, one tasteful accent color (deep indigo or forest green).
- Responsive: works from 360px width upward.
- Use TailwindCSS + shadcn/ui components throughout.

**Seed data**
- 20 sample customers with realistic (but fictional) company names, contacts, statuses.
- 12 sample deals distributed across the four pipeline stages.

**Tech**
- Pure frontend — no backend, no Supabase yet. State in React with useState/Context.
- TypeScript strict mode.
- Include a Reset Data button in Settings that reloads the initial seed.

Keep the first iteration tight and focused. No authentication, no dark mode yet, no search — those come in follow-up prompts.
