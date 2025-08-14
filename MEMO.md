# OMS Project Memo

## API
- Render backend: https://render-2siv.onrender.com
- Intake parsing: JSON-first schema
  - \/api/intake/parse?create=true|false\
  - \/api/intake2/parse\ (alternate route under consideration)
- Goal: robust parsing with full schema validation

## Frontend
- Vercel/Next.js (App Router) with TailwindCSS
- Pages: Intake, Orders, Payments, Schedules, Outstanding, Tools
- Top-right API Base selector (localStorage) to switch between local and Render

## Dev Preferences
- Windows-first workflow
- PowerShell one-liners
- No Docker locally
- DB inspection via Node \pg\ one-liners (no psql)

## Current Backend Endpoints (used by UI)
- \POST /api/intake/parse?create=true|false\
- \POST /api/orders\
- \GET  /api/orders\
- \POST /api/transactions\
- \POST /api/schedules\
- \GET  /api/outstanding?type=&overdue_only=&due_before=\
- \GET  /api/health\, \GET /api/db-health\

## Deployment
- Backend: Render (deploys from \main\)
- Frontend: Vercel (separate repo)
- Ensure CORS on backend allows your Vercel domain

## Roadmap
- View & edit orders from frontend
- Add payments/schedules from frontend
- Outstanding balance dashboards
- Auth & role-based access later
