/**
 * Spintax — {seçenek1|seçenek2|...} desenlerini rastgele bir seçenekle değiştirir.
 *
 * Cold outreach deliverability: her mail biraz farklı içerikle gider → spam filtreleri
 * "aynı bulk şablon" parmak izini yakalamaz, her gönderim benzersizleşir.
 *
 * Özellikler:
 *  - İç içe (nested) destekler: "{a|{b|c}}" → önce içteki çözülür, sonra dış.
 *  - SADECE pipe (|) içeren süslü parantezler işlenir. Bu sayede "{{var}}" mustache
 *    placeholder'ları ve CSS "{...}" blokları (pipe yok) ASLA dokunulmaz → güvenli.
 *  - rng enjekte edilebilir (deterministik test için).
 */
export function resolveSpintax(text: string, rng: () => number = Math.random): string {
  if (!text || text.indexOf('{') === -1 || text.indexOf('|') === -1) return text;
  // En içteki, pipe içeren grup: {…|…} (içinde başka süslü parantez yok)
  const probe = /\{[^{}]*\|[^{}]*\}/;
  const global = /\{([^{}]*\|[^{}]*)\}/g;
  let out = text;
  let guard = 0;
  while (probe.test(out)) {
    if (guard++ > 1000) break; // güvenlik valfi (patolojik input)
    out = out.replace(global, (_m, body: string) => {
      const opts = body.split('|');
      const idx = Math.min(opts.length - 1, Math.max(0, Math.floor(rng() * opts.length)));
      return opts[idx] ?? '';
    });
  }
  return out;
}
