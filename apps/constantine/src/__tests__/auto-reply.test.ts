/**
 * isAutoReply — OOO / otomatik yanıt algılama (Faz 0 / G2).
 * Amaç: auto-reply sequence'i durdurmasın + reply-rate'i şişirmesin.
 * False-positive maliyetli olduğu için sadece güçlü sinyaller true dönmeli.
 */
import { describe, it, expect } from 'vitest';
import { isAutoReply } from '../email-inbound.js';

describe('isAutoReply — header sinyalleri', () => {
  it('Auto-Submitted: auto-replied → true', () => {
    expect(isAutoReply('Re: teklif', { 'Auto-Submitted': 'auto-replied' })).toBe(true);
  });
  it('Auto-Submitted: auto-generated → true', () => {
    expect(isAutoReply('herhangi', { 'auto_submitted': 'auto-generated' })).toBe(true); // underscore normalize
  });
  it('Auto-Submitted: no → false', () => {
    expect(isAutoReply('Fiyat sorusu', { 'Auto-Submitted': 'no' })).toBe(false);
  });
  it('X-Autoreply present → true', () => {
    expect(isAutoReply('konu', { 'X-Autoreply': 'yes' })).toBe(true);
  });
  it('X-Auto-Response-Suppress (Outlook OOO) → true', () => {
    expect(isAutoReply('konu', { 'X-Auto-Response-Suppress': 'All' })).toBe(true);
  });
  it('Precedence: auto_reply → true', () => {
    expect(isAutoReply('konu', { 'Precedence': 'auto_reply' })).toBe(true);
  });
  it('Precedence: bulk → false (false-positive riski, bilinçli hariç)', () => {
    expect(isAutoReply('Re: yat kiralama', { 'Precedence': 'bulk' })).toBe(false);
  });
});

describe('isAutoReply — subject kalıpları (header yokken)', () => {
  it.each([
    'Out of Office',
    'Automatic reply: Re: teklif',
    'Auto-Reply: thanks',
    'I am away from the office',
    'On vacation until Monday',
    'Otomatik Yanıt: ofisten uzaktayım',
    'Ofisimden uzaktayım',
    'Yıllık izindeyim',
    'tatildeyim, döndüğümde yanıtlarım',
  ])('"%s" → true', (subject) => {
    expect(isAutoReply(subject, {})).toBe(true);
  });
});

describe('isAutoReply — gerçek yanıtlar (false dönmeli)', () => {
  it.each([
    'Re: yat kiralama hk.',
    'Fiyat listesi gönderir misiniz?',
    'Teşekkürler, ilgileniyoruz',
    'Toplantı ayarlayalım',
    'Re: Auto parts tedarik', // "auto" geçiyor ama "auto reply" değil
    'Lütfen bilgi bırakın',   // "leave" tuzağı yok
  ])('"%s" → false', (subject) => {
    expect(isAutoReply(subject, {})).toBe(false);
  });

  it('boş subject + header yok → false', () => {
    expect(isAutoReply('', {})).toBe(false);
    expect(isAutoReply(null, null)).toBe(false);
  });
});
