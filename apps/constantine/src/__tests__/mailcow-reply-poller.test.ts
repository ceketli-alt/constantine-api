/**
 * Mailcow reply poller — pure helper testleri (parseMailboxes, refsToString).
 * IMAP bağlantısı entegrasyon; burada sadece saf mantık test edilir.
 */
import { describe, it, expect } from 'vitest';
import { parseMailboxes, refsToString } from '../mailcow-reply-poller.js';

describe('parseMailboxes', () => {
  it('boş/undefined → []', () => {
    expect(parseMailboxes(undefined)).toEqual([]);
    expect(parseMailboxes('')).toEqual([]);
  });

  it('tek mailbox', () => {
    expect(parseMailboxes('outreach@cy.online:Secret123')).toEqual([
      { user: 'outreach@cy.online', pass: 'Secret123' },
    ]);
  });

  it('çoklu mailbox', () => {
    expect(parseMailboxes('a@x.com:p1,b@y.com:p2')).toEqual([
      { user: 'a@x.com', pass: 'p1' },
      { user: 'b@y.com', pass: 'p2' },
    ]);
  });

  it("şifrede ':' varsa ilk ':' ayraç, gerisi şifre", () => {
    expect(parseMailboxes('mert@cy.online:Mert:Mail:2026!')).toEqual([
      { user: 'mert@cy.online', pass: 'Mert:Mail:2026!' },
    ]);
  });

  it('geçersiz girdiler atlanır (@ yok / pass yok)', () => {
    expect(parseMailboxes('notanemail:p, nopass@x.com:, valid@x.com:ok')).toEqual([
      { user: 'valid@x.com', pass: 'ok' },
    ]);
  });

  it('boşluk trim edilir', () => {
    expect(parseMailboxes(' a@x.com:p1 , b@y.com:p2 ')).toEqual([
      { user: 'a@x.com', pass: 'p1' },
      { user: 'b@y.com', pass: 'p2' },
    ]);
  });
});

describe('refsToString', () => {
  it('array → boşlukla join', () => {
    expect(refsToString(['<a@x>', '<b@x>'])).toBe('<a@x> <b@x>');
  });
  it('string → aynen', () => {
    expect(refsToString('<a@x> <b@x>')).toBe('<a@x> <b@x>');
  });
  it('null/undefined/obje → boş string', () => {
    expect(refsToString(null)).toBe('');
    expect(refsToString(undefined)).toBe('');
    expect(refsToString({})).toBe('');
  });
});
