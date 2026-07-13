# Logs drop folder

Drop your Railway log CSV exports here — one per day. They are named like:

    logs.1783789145234.csv

Then, from the `server/` folder, run:

    npx tsx prisma/scripts/daily-report.ts

With no arguments the report script reads **every** `*.csv` in this folder,
merges + de-duplicates the events, and writes a styled Excel report
(`daily-orders-report-<range>.xlsx`) into this same folder.

Options:
    --date=YYYY-MM-DD   only that one day (UTC)
    --out=path.xlsx     custom output file
    <path>              a specific CSV file OR a different folder of CSVs

Tip: point `server/.env`'s DATABASE_URL at the production database when you run
it, so every user/game id resolves to a real name.

CSV files in here are ignored by git (see .gitignore) — they can contain data.
