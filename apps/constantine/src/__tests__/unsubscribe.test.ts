/**
 * Unsubscribe token + URL + List-Unsubscribe header — pure-logic testleri.
 * Faz 0 / G1 — RFC 8058 one-click unsubscribe.
 */
import { describe, it, expect } from 'vitest';
import {
  unsubscribeToken,
  buildUnsubscribeUrl,
  buildListUnsubscribeHeaders,
} from '../unsubscribe.js';

const LEAD = '11111111-2222-3333-4444-555555555555';

describe('unsubscribeToken', () => {
  it('32-hex deterministik token üretir', () => {
    const t1 = unsubscribeToken(LEAD, 'email');
    const t2 = unsubscribeToken(LEAD, 'email');
    expect(t1).toBe(t2);
    expect(t1).toMatch(/^[0-9a-f]{32}$/);
  });

  it('farklı lead → farklı token', () => {
    expect(unsubscribeToken(LEAD, 'email')).not.toBe(unsubscribeToken('00000000-0000-0000-0000-000000000000', 'email'));
  });

  it('farklı channel → farklı token', () => {
    expect(unsubscribeToken(LEAD, 'email')).not.toBe(unsubscribeToken(LEAD, 'whatsapp'));
  });
});

describe('buildUnsubscribeUrl', () => {
  it('backend functions path + lead + channel + token içerir', () => {
    const url = buildUnsubscribeUrl(LEAD, 'email');
    expect(url).toContain('/functions/v1/unsubscribe');
    expect(url).toContain(`lead=${LEAD}`);
    expect(url).toContain('channel=email');
    expect(url).toContain(`token=${unsubscribeToken(LEAD, 'email')}`);
  });

  it('channel default email', () => {
    expect(buildUnsubscribeUrl(LEAD)).toContain('channel=email');
  });
});

describe('buildListUnsubscribeHeaders', () => {
  it('RFC 8058 header çifti — URL <> içinde + One-Click', () => {
    const h = buildListUnsubscribeHeaders(LEAD, 'email');
    expect(h['List-Unsubscribe']).toBe(`<${buildUnsubscribeUrl(LEAD, 'email')}>`);
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
});
