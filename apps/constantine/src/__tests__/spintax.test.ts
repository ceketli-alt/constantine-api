/**
 * Spintax resolver — pure-logic testleri (deterministik rng enjeksiyonu).
 * Feature #55 — cold outreach deliverability için {a|b|c} varyant desteği.
 */
import { describe, it, expect } from 'vitest';
import { resolveSpintax } from '../spintax.js';

// rng helper: hep ilk seçenek (0) / hep son seçenek (~1)
const first = () => 0;
const last = () => 0.999;

describe('resolveSpintax', () => {
  it('tek grup — rng=0 → ilk seçenek', () => {
    expect(resolveSpintax('{Merhaba|Selam}', first)).toBe('Merhaba');
  });

  it('tek grup — rng≈1 → son seçenek', () => {
    expect(resolveSpintax('{a|b|c}', last)).toBe('c');
  });

  it('cümle içinde grup', () => {
    expect(resolveSpintax('{Merhaba|Selam} dünya', first)).toBe('Merhaba dünya');
  });

  it('çoklu grup', () => {
    expect(resolveSpintax('{a|b} ve {c|d}', first)).toBe('a ve c');
  });

  it('nested — içten dışa (rng=0)', () => {
    // {b|c}→b, sonra {a|b}→a
    expect(resolveSpintax('{a|{b|c}}', first)).toBe('a');
  });

  it('nested — son seçenekler (rng≈1)', () => {
    // {b|c}→c, sonra {a|c}→c
    expect(resolveSpintax('{a|{b|c}}', last)).toBe('c');
  });

  it('mustache {{var}} ASLA dokunulmaz (pipe yok)', () => {
    expect(resolveSpintax('{{company_name}} merhaba', first)).toBe('{{company_name}} merhaba');
  });

  it('mustache + spintax birlikte (substitution sonrası senaryo)', () => {
    // email-send akışında mustache önce çözülür; burada düz metin + spintax
    expect(resolveSpintax('Acme için {teklif|öneri}', first)).toBe('Acme için teklif');
  });

  it('CSS benzeri {…} (pipe yok) dokunulmaz', () => {
    expect(resolveSpintax('p { color: red }', first)).toBe('p { color: red }');
  });

  it('pipe içermeyen düz metin aynen döner', () => {
    expect(resolveSpintax('hiç değişiklik yok', first)).toBe('hiç değişiklik yok');
  });

  it('boş seçenek desteklenir', () => {
    expect(resolveSpintax('bugün{!|}', last)).toBe('bugün'); // 2. seçenek boş
  });

  it('rng dağılımı — her seçenek üretilebiliyor', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(resolveSpintax('{x|y|z}'));
    expect(seen).toEqual(new Set(['x', 'y', 'z']));
  });
});
