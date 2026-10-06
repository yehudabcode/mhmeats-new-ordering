# MH Meats New Ordering Tool

A fresh ordering system, completely separate from the old `mhmeats-orders` tool.

| File | What it is |
|---|---|
| `index.html` + `app.js` | Staff tool (order input, summary, chef / butcher / packer / dispatch sheets, incoming orders, links, admin) |
| `portal.html` | Customer order form (one private link per customer) |
| `rules.js` | All production rules: butcher multipliers, butcher groups, beef categories, packer / chef / dispatch logic |
| `seed.js` | Starting catalogue (13 customers, 997 products) copied from the old tool — loaded **once** |
| `config.js` | **The only place the Google web app URL lives** |
| `api.js`, `style.css` | Connection code and styling shared by both pages |
| `Code.gs` | Google Apps Script backend — pasted into the Google Sheet, kept here as the backup copy |
| `tests/` | Automated checks (not used by the live site) |

## How it works

- **The Google Sheet is the one shared order book.** Every PC, phone and browser reads the same orders. Reading never changes anything, so nothing can be "used up".
- **Orders are stored against a real date** (for example 2026-09-29), not just "Tuesday". Last week can't leak into this week.
- **Every change saves immediately.** The status badge (top right) says **Live — all saved**, **Saving…** or **OFFLINE**. If the connection drops, changes wait on that PC and save by themselves when it returns.
- **Customers only see "Order received" after the Google Sheet confirms it.** Pressing Send twice creates one order, not two.
- **One product list** feeds both the staff tool and the customer portal. Products are edited in Admin.
- Works no matter which Google accounts are signed in on the PC.

## Rules to keep it watertight

1. GitHub is the master copy. Always edit the files here, never old downloads.
2. When `Code.gs` changes: in Apps Script go to **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. This keeps the same URL. Never create a second deployment.
3. After changing any file, raise the `?v=` number in `index.html` / `portal.html` and `BUILD` in `config.js`, so every PC loads the new version.
