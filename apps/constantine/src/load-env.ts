/**
 * .env loader — server.ts'in EN ÜST import'u olmalı.
 * ESM hoisting: import statements code execution'dan önce çözülür,
 * yani dotenv'in çağrı sırası garanti edilemez. Bu dosya en üstte
 * import edildiğinde, side-effect olarak .env yüklenir, sonra diğer
 * modüller (db.ts vs.) doğru process.env ile yüklenir.
 *
 * override:true — sistem env'inde ANTHROPIC_API_KEY=empty gibi
 * placeholder'lar varsa bizim .env'imiz öncelikli olsun.
 */
import { config } from 'dotenv';

config({ override: true });
