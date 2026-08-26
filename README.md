# 🌐 EWC Translation Hub — Server

The backend API for the **EWC Translation Hub**: authentication, order management, real-time updates, AI-assisted proofreading, and reporting for a large esports translation operation. Pairs with the **[EWC_TranslationHub](https://github.com/MaherLawand/EWC_TranslationHub)** frontend.

---

## ✨ What it does

- **Order engine** — full lifecycle for translation orders across **broadcast** and **marketing** workstreams, with deliveries, formats, assignments, priorities, and statuses.
- **Authentication & security** — password hashing with **bcrypt**, **JWT** sessions in secure cookies, account **lockout** after repeated failed logins, and email-based password reset & invites.
- **Role-based access control** — middleware guards routes by role (admin, producer, project/production manager, report owner).
- **Real-time** — pushes live order/notification updates to clients over **Socket.IO**.
- **AI proofreading & glossary consistency** — uses the **OpenAI API** to proofread translations and enforce consistent esports terms, player and team names (with a term memory of past decisions and Liquipedia cross-checks). Handles **SRT subtitle** files.
- **Reporting** — analytics endpoints and **Excel (.xlsx)** report exports.
- **Email** — invites, password resets, lockout alerts, and feedback notifications (Nodemailer / Resend).
- **Hardening** — Helmet security headers, rate limiting, and Zod request validation.

## 🧱 Tech Stack

| Area | Technology |
|---|---|
| **Runtime** | Node.js + Express 5 (TypeScript) |
| **Database** | PostgreSQL via **Prisma** ORM (15+ models) |
| **Auth** | JWT (`jsonwebtoken`), bcrypt, cookies |
| **Real-time** | Socket.IO |
| **AI** | OpenAI API |
| **Validation** | Zod |
| **Security** | Helmet, express-rate-limit |
| **Email** | Nodemailer, Resend |
| **Files** | ExcelJS (reports), Sharp (images) |
| **Deploy** | Railway |

## 🏗️ Architecture

```
src/
├── routes/         # auth, orders, games, reports, analytics, srt, users
├── controllers/    # request handlers per domain
├── middleware/     # auth, admin, producer, PPM, report-owner guards
├── lib/            # prisma, socket, mailer, glossary/proofread, srt, logger
└── utils/          # token generation, email senders
prisma/
├── schema.prisma   # data model (Users, TranslationOrders, Games, ...)
└── migrations/     # database history
```

Requests flow **route → middleware (auth/role) → controller → Prisma → PostgreSQL**, with Socket.IO emitting live updates and Zod validating input at the edges.

## 🚀 Getting Started

```bash
# 1. Install dependencies
npm install

# 2. Create a .env with (at minimum):
#    DATABASE_URL=postgresql://...
#    JWT_SECRET=...
#    OPENAI_API_KEY=...
#    (plus email + client URL settings)

# 3. Generate the Prisma client & run migrations
npx prisma generate
npx prisma migrate deploy

# 4. Start the dev server (hot reload)
npm run dev
```

## 📝 Notes

- All secrets (database URL, JWT secret, OpenAI key, email credentials) are provided via environment variables and are never committed.

---

_Built by [Maher Lawand](https://github.com/MaherLawand)._
