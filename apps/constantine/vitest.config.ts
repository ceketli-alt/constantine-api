import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 10000,
    // DB veya external API isteyen testler explicit olarak skip eder; default sadece
    // pure-logic test'leri çalıştırır.
    setupFiles: [],
    // db.ts import-anında DATABASE_URL ister (yoksa throw). Pure-logic testleri db'ye dokunan
    // modülleri (unsubscribe.ts, email-inbound.ts) import edebilsin diye bogus URL veriyoruz.
    // Kapalı port → yanlışlıkla sorgu atılırsa gerçek DB'ye DEĞİL, ECONNREFUSED'a gider.
    env: {
      DATABASE_URL: 'postgres://nobody:nopass@127.0.0.1:1/none',
      // auth.ts import-anında JWT_SECRET (≥32 char) ister; campaign-worker → email-send → middleware
      // → auth zinciri için dummy. Gerçek secret prod .env'de.
      JWT_SECRET: 'test-only-dummy-jwt-secret-0123456789abcdef',
    },
  },
});
