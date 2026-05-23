# Constantine API Workspace

Backend API monorepo. Üç ayrı app, ortak Postgres, tek pm2 grubu.

## Yapı

```
/var/www/api/
├── apps/
│   ├── ibrahim/      → port 4002, DB: ibrahim_acente
│   ├── concierge/    → port 4003, DB: concierge_connect
│   └── constantine/  → port 4001, DB: constantine
├── packages/
│   ├── auth/         → JWT + argon2 (ortak)
│   ├── db/           → drizzle config + migration helpers
│   └── shared/       → tipler, util
├── migrations/       → her DB için ayrı klasör
└── scripts/          → pg_dump, restore, smoke test
```

## Stack

- **Runtime**: Node 20 + TypeScript
- **HTTP**: Hono (Cloudflare/Bun/Node uyumlu, hızlı)
- **DB**: postgres (pg client) + Drizzle ORM
- **Auth**: argon2 + jose (JWT HS256, refresh token rotation)
- **Validation**: Zod
- **Process**: pm2 (root systemd unit altında)

## Geliştirme

```bash
pnpm install
pnpm dev:ibrahim    # localhost:4002
pnpm dev:concierge  # localhost:4003
pnpm dev:constantine # localhost:4001
```

## Production

`pm2 start ecosystem.config.cjs` → 3 app birden ayağa kalkar, `pm2 save` ile reboot dayanıklı.

## Postgres bağlantı

Credentials `/root/postgres-credentials.env`'da. Her app kendi DATABASE_URL'ini `.env`'den okur.

## nginx routing

```
api.constantineyachts.com         → :4001  (constantine)
api-ibrahim.constantineyachts.com → :4002  (ibrahim)
api-cc.constantineyachts.com      → :4003  (concierge)
```
