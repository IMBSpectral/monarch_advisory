# Monarch ERP — Investor Prototype Plan

A polished, click-through UI prototype of **Monarch ERP** — a Zoho Books-style accounting & business platform, but broader (accounting + inventory + CRM + commerce + dashboards + workflow automation + AI Foundation), as described in your Monarch-ERP delivery plan and Zoho Books feature docs.

All screens will be fully designed with realistic dummy data, charts, tables, and interactions so investors perceive it as a finished product. No backend — pure frontend prototype.

## Design direction

- **Aesthetic:** modern SaaS, dense-but-clean (Linear / Ramp / Zoho refined). Sidebar + topbar shell, card-based dashboards, subtle motion.
- **Palette:** deep navy + emerald prestige accent + soft neutrals (premium finance feel). Dark mode ready.
- **Typography:** Inter for UI, tabular numerics for money columns.
- **Brand:** "Monarch ERP" with a crown-mark logo.

## App shell

- Persistent left sidebar with grouped nav (Home, Accounting, Sales, Purchases, Inventory, CRM, POS, Banking, Reports, Automation, AI, Settings).
- Top bar: company/branch switcher (multi-company), global search, quick-create (+), notifications, AI Assistant launcher, user menu.
- Right-side slide-over **AI Assistant** (Chat, AI Accountant, AI CFO tabs) available on every page.

## Modules & screens (all with dummy data)

**1. Executive Home / CEO Dashboard**
KPI cards (Revenue, Net Profit, Cash Position, AR, AP, Inventory Value), revenue vs expense area chart, cash flow bar chart, top customers, aging summary, AI insights strip.

**2. Accounting**

- Chart of Accounts (tree)
- Journal Entries list + entry detail (double-entry lines)
- General Ledger & Trial Balance
- P&L, Balance Sheet, Cash Flow statement pages
- GST summary (GSTR-style tiles)

**3. Sales**

- Dashboard (sales KPIs, funnel, top items)
- Invoices list + Invoice detail (Zoho-style with PDF preview panel)
- Quotations, Sales Orders, Credit Notes
- Customers list + Customer 360 (transactions, statement, aging)

**4. Purchases**

- Bills, Purchase Orders, Vendor Credits, Expenses
- Vendors list + Vendor 360

**5. Inventory**

- Items master (SKU grid with images, stock, valuation)
- Warehouses (zones/bins), Stock Movements, Transfers, Adjustments
- Valuation report (FIFO / Weighted Avg toggle)
- Barcode/QR view on item detail

**6. CRM**

- Leads Kanban, Deals pipeline, Contacts, Activity timeline

**7. POS**

- Touch-friendly checkout screen (product grid, cart, split payment, receipt preview)

**8. Banking**

- Accounts overview, transactions feed, reconciliation screen (match suggestions)

**9. Reports**
Grid of 30+ report tiles categorized (Financial, Sales, Purchase, Inventory, Tax, Payroll-ready).

**10. Workflow Automation**

- Visual workflow builder canvas (nodes: Trigger → Condition → Action, drag-drop look)
- Approval flows list, Notification/Email templates, Escalation rules

**11. AI Foundation**

- AI Assistant chat (sample Q&A: "Show me overdue invoices", "Forecast next month cash")
- AI Accountant page (auto journal suggestions, anomaly flags)
- AI CFO page (cash forecast chart, budget variance, narrative summary)
- Prompt/Knowledge Base admin

**12. Settings**

- Organization (multi-company, branches, departments)
- Users & Roles (RBAC matrix)
- Taxes (GST), Currencies, Payment terms
- Customer/Vendor Portal preview
- Integrations gallery

**13. Auth screens**
Polished Login / Signup / Company selector (not gated — for demo).

## Technical approach

- TanStack Start file-based routing under `src/routes/` — one route per screen listed above.
- Shared `AppShell` layout in a pathless `_app.tsx` layout route wrapping all authenticated pages.
- Shadcn UI + Tailwind v4 tokens; add semantic tokens for navy/emerald + gradients + elegant shadow in `src/styles.css`.
- Recharts for all charts.
- lucide-react icons.
- All data from typed dummy fixtures in `src/data/*.ts` (customers, invoices, items, journals, KPIs, etc.) — realistic Indian-context numbers (₹), GST rates, company "IMB Labs LLP".
- Fully responsive; sidebar collapses on mobile.
- Home route (`/`) = Executive Dashboard (replaces placeholder). Landing/login accessible at `/login`.

## Scope guardrails for the 1-hour build

- Every route renders a complete, visually rich screen — no "coming soon" placeholders.
- No auth, no DB, no server functions. Pure UI. Buttons open dialogs / toasts.
- Focus polish on: Dashboard, Invoices list + detail, Items, Workflow Builder, AI Assistant — these are the demo hero screens.
- Secondary screens (transfers, credit notes, etc.) still fully designed but reuse table patterns.

## Deliverable

A running preview at `/` showing the CEO dashboard, with a working sidebar navigating to ~25 fully designed screens with dummy data — presentable end-to-end as a finished product.

Approve this and I'll build it immediately.
