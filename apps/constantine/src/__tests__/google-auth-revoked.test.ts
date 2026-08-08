/**
 * refreshAccessToken hata sınıflandırması:
 * 400 invalid_grant = KALICI (token iptal/expire) → GoogleAuthRevokedError,
 * diğer her hata = geçici kabul edilir → sıradan Error (retry mantıklı).
 * partner-calendar-sync bu ayrıma göre bağlantıyı kapatır (White Istanbul dersi, 2026-08-03).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { refreshAccessToken, GoogleAuthRevokedError } from '../google.js';

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockTokenResponse(status: number, body: string) {
  globalThis.fetch = vi.fn(async () => new Response(body, { status })) as any;
}

describe('refreshAccessToken — invalid_grant sınıflandırması', () => {
  it('400 invalid_grant → GoogleAuthRevokedError (kalıcı)', async () => {
    mockTokenResponse(400, '{"error":"invalid_grant","error_description":"Bad Request"}');
    await expect(refreshAccessToken('dead-token')).rejects.toBeInstanceOf(GoogleAuthRevokedError);
  });

  it('400 ama farklı hata (invalid_client) → sıradan Error', async () => {
    mockTokenResponse(400, '{"error":"invalid_client"}');
    const err = await refreshAccessToken('t').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GoogleAuthRevokedError);
    expect(err.message).toContain('refresh failed: 400');
  });

  it('500 → sıradan Error (geçici, revoked sayılmaz)', async () => {
    mockTokenResponse(500, 'server error');
    const err = await refreshAccessToken('t').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GoogleAuthRevokedError);
    expect(err.message).toContain('refresh failed: 500');
  });

  it('200 → token döner, hata yok', async () => {
    mockTokenResponse(200, JSON.stringify({
      access_token: 'fresh', expires_in: 3600, scope: 's', token_type: 'Bearer',
    }));
    const tok = await refreshAccessToken('alive-token');
    expect(tok.access_token).toBe('fresh');
  });
});
