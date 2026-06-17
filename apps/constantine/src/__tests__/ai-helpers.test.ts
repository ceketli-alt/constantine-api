/**
 * AI yardımcı pure-prompt builder testleri (Faz 2).
 * reply-draft buildDraftUserPrompt + icebreaker buildIcebreakerPrompt — Claude'suz, deterministik.
 */
import { describe, it, expect } from 'vitest';
import { buildDraftUserPrompt } from '../reply-draft.js';
import { buildIcebreakerPrompt } from '../icebreaker.js';

describe('buildDraftUserPrompt', () => {
  const base = {
    company: 'Pera Palace',
    contact: 'Ayşe Y.',
    subject: 'Boğaz turu işbirliği',
    messages: [
      { direction: 'outbound', body: 'Merhaba, partner programımız hk.' },
      { direction: 'inbound', from_name: 'Ayşe', body: 'Fiyat listesi paylaşır mısınız?' },
    ],
  };

  it('şirket, kişi, konu ve yazışmayı içerir', () => {
    const p = buildDraftUserPrompt(base);
    expect(p).toContain('Pera Palace');
    expect(p).toContain('Ayşe Y.');
    expect(p).toContain('Boğaz turu işbirliği');
    expect(p).toContain('MÜŞTERİ');
    expect(p).toContain('Fiyat listesi paylaşır mısınız?');
  });

  it('default dil Türkçe + default ton', () => {
    const p = buildDraftUserPrompt(base);
    expect(p).toContain('Türkçe');
    expect(p).toContain('profesyonel-samimi');
  });

  it('tone/language/instructions override edilebilir', () => {
    const p = buildDraftUserPrompt({ ...base, tone: 'resmi', language: 'İngilizce', instructions: 'fiyat verme' });
    expect(p).toContain('İngilizce');
    expect(p).toContain('resmi');
    expect(p).toContain('fiyat verme');
  });

  it('son 6 mesajla sınırlar (uzun thread)', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ direction: i % 2 ? 'inbound' : 'outbound', body: `msg${i}` }));
    const p = buildDraftUserPrompt({ ...base, messages: many });
    expect(p).toContain('msg9');
    expect(p).not.toContain('msg0'); // ilk mesajlar kesilir
  });
});

describe('buildIcebreakerPrompt', () => {
  it('şirket + web + kategori içerir', () => {
    const p = buildIcebreakerPrompt({
      company_name: 'Acme DMC',
      segment: 'dmc',
      city: 'İstanbul',
      district: 'Beşiktaş',
      website: 'acme.example',
      source_meta: { google_primary_type: 'travel_agency', rating: 4.6 },
    });
    expect(p).toContain('Acme DMC');
    expect(p).toContain('travel_agency');
    expect(p).toContain('acme.example');
    expect(p).toContain('inbound DMC');
  });

  it('KONUM TUZAĞI: ofis ilçesi/şehir prompt’a SOKULMAZ (inbound DMC — ilçe tur yeri değil)', () => {
    const p = buildIcebreakerPrompt({
      company_name: 'Acme DMC',
      city: 'İstanbul',
      district: 'Beşiktaş',
    });
    // district/city kasıtlı dışlanır → model "Beşiktaş'taki turlarınız" gibi yanlış kuramaz.
    expect(p).not.toContain('Beşiktaş');
    expect(p).not.toContain('Konum');
  });

  it('eksik alanlar sorun çıkarmaz', () => {
    const p = buildIcebreakerPrompt({ company_name: 'X Otel' });
    expect(p).toContain('X Otel');
    expect(typeof p).toBe('string');
  });
});
