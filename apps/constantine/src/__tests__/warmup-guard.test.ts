import { describe, it, expect } from 'vitest';
import { duraklatmaKarari, MIN_ORAN_HACMI, MUTLAK_BOUNCE_SINIRI } from '../warmup-guard.js';

describe('warmup duraklatma karari', () => {
  it('asgari hacmin ALTINDA tek bounce durdurmaz (26 Agu: 1C 5 gonderimde 1 bounce ile duruyordu)', () => {
    expect(duraklatmaKarari(5, 1, 0)).toEqual({ durdur: false });
  });

  it('asgari hacmin altinda 2 bounce da durdurmaz', () => {
    expect(duraklatmaKarari(8, 2, 0)).toEqual({ durdur: false });
  });

  it('asgari hacmin altinda 3 bounce MUTLAK sinir — durdurur', () => {
    const k = duraklatmaKarari(8, MUTLAK_BOUNCE_SINIRI, 0);
    expect(k.durdur).toBe(true);
    expect(k.durdur && k.sebep).toBe('bounce_threshold');
    expect(k.durdur && k.saat).toBe(24);
  });

  it('hicbir sey gonderilmediyse ve bounce yoksa durdurmaz', () => {
    expect(duraklatmaKarari(0, 0, 0)).toEqual({ durdur: false });
  });

  it('esik hacimde %5 TAM SINIR durdurmaz (1/20)', () => {
    expect(duraklatmaKarari(MIN_ORAN_HACMI, 1, 0)).toEqual({ durdur: false });
  });

  it('esik hacimde %5 ustu durdurur (2/20)', () => {
    const k = duraklatmaKarari(20, 2, 0);
    expect(k.durdur).toBe(true);
    expect(k.durdur && k.sebep).toBe('bounce_threshold');
  });

  it('yeni tavanda (25/gun) tek bounce durdurmaz, iki bounce durdurur', () => {
    expect(duraklatmaKarari(25, 1, 0).durdur).toBe(false);
    expect(duraklatmaKarari(25, 2, 0).durdur).toBe(true);
  });

  it('sikayet kurali GEVSETILMEDI: dusuk hacimde tek sikayet 72 saat durdurur', () => {
    const k = duraklatmaKarari(5, 0, 1);
    expect(k.durdur).toBe(true);
    expect(k.durdur && k.sebep).toBe('complaint_threshold');
    expect(k.durdur && k.saat).toBe(72);
  });

  it('bounce ve sikayet birlikteyse bounce once degerlendirilir', () => {
    const k = duraklatmaKarari(40, 5, 1);
    expect(k.durdur && k.sebep).toBe('bounce_threshold');
  });
});
