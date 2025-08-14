# FastAPI Migration for `contactevin2u/render`

This folder (`backend/`) is a drop-in Python FastAPI backend that matches and extends the Node/Express API previously in the repo.

## Deploy on Render
- Add this repo to Render and ensure it uses **render.yaml** at root.
- Set env vars: `DATABASE_URL`, `OPENAI_API_KEY`, `CORS_ORIGIN`, `TZ=Asia/Kuala_Lumpur`.
- Render will build with `backend/requirements.txt` and start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`.

## Local dev
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export DATABASE_URL="postgresql+psycopg2://user:pass@host:5432/db"
export OPENAI_API_KEY=sk-...
export CORS_ORIGIN=http://localhost:3000
uvicorn app.main:app --reload
```

## Notes
- Database tables are created under `*2` suffix (e.g., `orders2`) to avoid clashing with your existing Node tables. You can migrate data later if needed.
- Endpoints preserved (compat): `/api/health`, `/api/db-health`, `/api/intake/parse?create=`, `/api/orders` (GET/POST), `/api/transactions` (POST), `/api/outstanding` (GET).
- New endpoints: `/parse`, `/orders`, `/outstanding`, brandable PDFs at `/orders/{code}/invoice.pdf` and `/orders/{code}/receipt.pdf`, Excel export `/export/excel`, SKU suggestions `/suggest/items`, profile `/settings/profile`.
- Auto-status: RETURN/COLLECT → RETURNED; INSTALMENT_CANCEL/BUYBACK → CANCELLED.
- SKU auto-fill suggestions are available via `/suggest/items` and applied on create if price=0.
- PDFs branded via `/settings/profile`.
