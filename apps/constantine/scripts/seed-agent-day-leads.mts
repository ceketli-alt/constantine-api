/**
 * seed-agent-day-leads.mts — Agent Day 2026-06-04 follow-up batch'i CRM'e ekler.
 *
 * Amaç: 2026-06-04 Agent Day etkinliğinde kart bırakan 18 firma + 1 ek Zesa kişi
 * = 19 lead'i `leads` tablosuna upsert eder. Aynı zamanda bunları target olarak
 * bağlayan bir DRAFT campaign yaratır (Warmup Batch 2026-06-08 → 12).
 *
 * Pattern: scripts/seed-inbox-test.mts taklit edilmiştir.
 * - source = 'agent-day-2026-06-04' → audit + filter için
 * - tags = ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-pX', segment ...]
 * - status = 'new' (default)
 * - campaign status = 'draft' (worker dokunmaz, Mert manuel launch eder)
 * - campaign_targets status = 'queued'
 *
 * Modlar:
 *   (arg yok)                          → DRY: ne yapacağını yazar, GÖNDERMEZ
 *   npx tsx scripts/seed-agent-day-leads.mts upsert  → leads + campaign yaratır
 *   npx tsx scripts/seed-agent-day-leads.mts cleanup → tüm Agent Day verilerini siler
 *
 * Çalıştırma: cd /var/www/api/apps/constantine && npx tsx scripts/seed-agent-day-leads.mts upsert
 */
import 'dotenv/config';
import { sql } from '../src/db.js';

const CAMPAIGN_NAME = 'Warmup Batch — Agent Day 2026-06-04';
const CAMPAIGN_DESC = 'Agent Day 2026-06-04 etkinliği sonrası 19 firma için kişiselleştirilmiş follow-up. ' +
  'Tarih dağılımı: Pzt 4 (2026-06-08) / Sal 4 / Çar 4 / Per 5 / Cum 2. ' +
  'Mail draftları: /root/.claude/plans/agent-day-2026-06-04/tum-mailler.txt';
const SOURCE = 'agent-day-2026-06-04';
const SENDER_EMAIL = 'outreach@constantineyachts.online';

type LeadInput = {
  company_name: string;
  legal_name?: string | null;
  primary_contact_name: string;
  primary_contact_role: string;
  primary_contact_email: string;
  primary_contact_phone: string;
  website?: string | null;
  city?: string | null;
  country?: string;
  type: string;             // lead_type enum
  segment: string;          // lead_segment enum
  temperature: 'hot' | 'warm' | 'cold';
  tags: string[];           // priority + segment + warmup day tags
  notes: string;            // konuşulan konu + profil + uyarılar
  custom_fields: Record<string, any>;
};

// ---------------------------------------------------------------
// 19 firma — Agent Day 2026-06-04 raw data
// ---------------------------------------------------------------
const LEADS: LeadInput[] = [
  // === PZT 2026-06-08 (4 hot Tier 1) ===
  {
    company_name: 'The Allure Travel',
    primary_contact_name: 'Ghassan Khraim',
    primary_contact_role: 'Event Manager',
    primary_contact_email: 'ghassan@thealluretravel.com',
    primary_contact_phone: '+90 532 221 33 21',
    website: 'http://www.thealluretravel.com',
    city: 'İstanbul',
    country: 'TR',
    type: 'dmc',
    segment: 'dmc',
    temperature: 'hot',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p1', 'warmup-pzt', 'segment-dmc', 'segment-mice', 'segment-luks', 'decision-role-decision-maker', 'top-prospect'],
    notes: 'Tier 1 — EN GÜÇLÜ LEAD. Event Manager pozisyonu + portföyde zaten Yacht Rentals var + Ghassan Khraim Arap kökenli (muhtemel Körfez/Lübnan VIP). Reseller anlaşması veya tercih edilen yat partneri statüsü hedef. Önerilen format: gala paketi 35-80 kişi Boğaz + VIP intimate weekend 12-30 kişi Bodrum. Concierge Connect reseller programının ideal hedefi.',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'pzt-2026-06-08',
      send_time_tr: '10:00',
      mail_subject: 'Ghassan Bey, dünden devam — tercih edilen yat partneri',
      personalization_hook: 'Yacht Rentals zaten portföyünüzde — tercih edilen yat partneri statüsü',
      ideal_format: '35-80 kişi MICE gala Boğaz + 12-30 kişi VIP intimate Bodrum',
      special_offer_expiry: '2026-08-04',
    },
  },
  {
    company_name: 'Universal Travel Services',
    legal_name: 'Universal Turizm',
    primary_contact_name: 'Mustafa Devrim Yalçın',
    primary_contact_role: 'Managing Partner + Skål Istanbul Başkanı (2026)',
    primary_contact_email: 'mustafa@universaltravel-tr.com',
    primary_contact_phone: '+90 212 246 29 08',
    website: 'https://www.universaltravel-tr.com',
    city: 'İstanbul',
    country: 'TR',
    type: 'dmc',
    segment: 'dmc',
    temperature: 'hot',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p1', 'warmup-pzt', 'segment-dmc', 'segment-mice', 'segment-pco', 'decision-role-decision-maker', 'top-prospect'],
    notes: 'Tier 1 — STRATEJİK. 40+ yıllık MICE DMC (1984) + 2026 Skål Istanbul Başkanı + 2015 Skalite Best Incoming DMC. ABD/Avrupa kongre delegasyonları için Boğaz gala teknesi sürdürülebilir tedarikçi ilişkisi. Multi-year hesap potansiyeli. UYARI: kartvizittekt email "unıversal" (Türkçe ı) yanlış yazılmıştı — doğru "universal" (Latin i).',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'pzt-2026-06-08',
      send_time_tr: '10:12',
      mail_subject: 'Mustafa Bey, Skål başkanlığınızı tebrik — Constantine',
      personalization_hook: '2026 Skål Istanbul başkanlığı tebrik + 40+ yıl MICE deneyim',
      ideal_format: '60-120 kişi MICE gala SKU Boğaz + kongre welcome cocktail',
      data_correction: 'Email Latin i: universal (kartvizittekt unıversal Türkçe ı yanlıştı)',
      special_offer_expiry: '2026-08-04',
    },
  },
  {
    company_name: 'Carat Tours',
    primary_contact_name: 'A. Esat Yalçın',
    primary_contact_role: 'Managing Director (Istanbul) + Managing Partner (Carat Hellas Athens)',
    primary_contact_email: 'esat@carattours.com',
    primary_contact_phone: '+90 533 484 51 68',
    website: 'https://carattours.com',
    city: 'İstanbul',
    country: 'TR',
    type: 'dmc',
    segment: 'dmc',
    temperature: 'hot',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p1', 'warmup-pzt', 'segment-mice', 'segment-dmc', 'segment-dach', 'decision-role-decision-maker', 'top-prospect'],
    notes: 'Tier 1 — Almanca pazar MICE 35+ yıl + İstanbul+Bodrum + Carat Hellas Atina (2024-25). Website Almanca, DACH pazar. Yat üzeri gala dinner birebir match. Linkedin: linkedin.com/in/a-esat-yalçin-71243132',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'pzt-2026-06-08',
      send_time_tr: '10:25',
      mail_subject: 'Esat Bey, Almanca incentive grupları için Constantine',
      personalization_hook: '35 yıllık Almanca pazar deneyimi + İstanbul-Bodrum + Carat Hellas',
      ideal_format: '50-120 kişi Almanca incentive Boğaz gala; Bodrum private gulet/motoryat; Atina-Bodrum/İzmir Ege add-on',
      linkedin: 'https://www.linkedin.com/in/a-esat-yalçin-71243132/',
      special_offer_expiry: '2026-08-04',
    },
  },
  {
    company_name: 'Gurtour',
    legal_name: 'Gurtour Travel',
    primary_contact_name: 'Gül Taner',
    primary_contact_role: 'Owner & Sales Manager',
    primary_contact_email: 'gul@gurtour.com',
    primary_contact_phone: '+90 542 585 87 18',
    website: 'http://www.gurtour.com',
    city: 'İstanbul',
    country: 'TR',
    type: 'dmc',
    segment: 'dmc',
    temperature: 'hot',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p1', 'warmup-pzt', 'segment-dmc', 'segment-incoming', 'decision-role-decision-maker', 'top-prospect'],
    notes: 'Tier 1 — 33 yıllık DMC (1992) + ZATEN "Cruises and Yacht Tours" portföyünde + 6 dil rehber. Aile şirketi: Gurol Taner President (baba), Gül Owner&Sales, Pırıl Hancı Incoming. F1/ANZAC/Hristiyan pilgrimage/kongre kanalları. UYARI: Mail Gül Hanım\'a (karar verici), CC YAPMA.',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'pzt-2026-06-08',
      send_time_tr: '10:40',
      mail_subject: 'Gül Hanım, Cruises & Yacht Tours portföyü için — Constantine',
      personalization_hook: '33 yıl incoming + Cruises and Yacht Tours portföyü mevcut',
      ideal_format: 'F1 VIP yat hospitality; anglofon kongre gala 50-120 kişi; ANZAC add-on; Hristiyan Ege motoryat',
      family_business_note: 'Gurol Taner President baba; Pırıl Hancı incoming@ — mail sadece gul@',
      special_offer_expiry: '2026-08-04',
    },
  },

  // === SAL 2026-06-09 (4 Tier 1 devam) ===
  {
    company_name: 'Intra Tours',
    legal_name: 'Intra Tourism Group / Intra World',
    primary_contact_name: 'Yeliz Çimen',
    primary_contact_role: 'Executive Coordinator (kart: Director — açık kaynaklarda Executive Coordinator)',
    primary_contact_email: 'yelizcimen@intraturkey.com',
    primary_contact_phone: '+90 553 682 84 08',
    website: 'https://www.intra-world.com/',
    city: 'İstanbul',
    country: 'TR',
    type: 'dmc',
    segment: 'dmc',
    temperature: 'hot',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p1', 'warmup-sal', 'segment-dmc', 'segment-mice', 'decision-role-influencer'],
    notes: 'Tier 1 — 1980 kuruluş, 4 ülke (TR + 2016 Yunanistan + 2018 Kıbrıs/Bulgaristan). Cvent Istanbul MICE venue partner. Zaten yat ürünü satıyor (rakip değil tamamlayıcı). UYARI: Pozisyon kartta "Director" ama 3 kaynak Executive Coordinator. Hitap "Yeliz Hanım" — "Direktör" deme. Şirket LinkedIn: linkedin.com/company/intratourism',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'sal-2026-06-09',
      send_time_tr: '10:00',
      mail_subject: 'Yeliz Hanım, Aegean yacht ekosistemi — Constantine',
      personalization_hook: '4 ülke incoming + Aegean & Mediterranean yacht ürünü mevcut',
      ideal_format: '40-80 kişi corporate MICE charter Boğaz veya Bodrum/Göcek leg',
      data_correction: 'Pozisyon kartta "Director" yanlış — açık kaynak Executive Coordinator. Hitap nötr "Yeliz Hanım".',
      linkedin_company: 'https://www.linkedin.com/company/intratourism',
      special_offer_expiry: '2026-08-04',
    },
  },
  {
    company_name: 'Present Tour',
    primary_contact_name: 'Murat Kartal',
    primary_contact_role: 'Yönetici (kart pozisyon boş)',
    primary_contact_email: 'murat.kartal@presenttour.com.tr',
    primary_contact_phone: '+90 212 225 71 88',
    website: 'https://www.presenttour.com.tr/',
    city: 'İstanbul',
    country: 'TR',
    type: 'dmc',
    segment: 'dmc',
    temperature: 'hot',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p1', 'warmup-sal', 'segment-luks-butik', 'segment-mice'],
    notes: 'Tier 1 — 32 yıl operasyon (1993). Sitede "Tours & Yachting" + "Meeting & Incentives" yan yana. Toscana signature. TÜRSAB 2503. Constantine\'i Türkiye leg operasyon partneri olarak konumla.',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'sal-2026-06-09',
      send_time_tr: '10:12',
      mail_subject: 'Murat Bey, Türkiye leg partneri — Tours & Yachting',
      personalization_hook: 'Tours & Yachting + Meeting & Incentives sitede yan yana',
      ideal_format: '30-80 kişi kurumsal launch/incentive Boğaz; 12-20 kişi Türk Toskanası butik VIP Bodrum/Göcek',
      special_offer_expiry: '2026-08-04',
    },
  },
  {
    company_name: 'Turquirama',
    primary_contact_name: 'Gürkan Eliçin',
    primary_contact_role: 'CEO / Yönetim Kurulu Üyesi',
    primary_contact_email: 'gurkan@turquirama.com',
    primary_contact_phone: '+90 532 611 44 15',
    website: 'https://turquirama.com',
    city: 'İstanbul',
    country: 'TR',
    type: 'dmc',
    segment: 'dmc',
    temperature: 'hot',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p1', 'warmup-sal', 'segment-dmc', 'segment-luks-butik', 'segment-frankofon', 'decision-role-decision-maker'],
    notes: 'Tier 1 — 2013 kuruluş ama kurucu ekip 35+ yıl. Frankofon pazar (FR/BE/CH/CA-Quebec/Kuzey Afrika). EasyGulet markası altında zaten gulet satıyor. Constantine motoryat = tamamlayıcı premium katman, rakip değil.',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'sal-2026-06-09',
      send_time_tr: '10:25',
      mail_subject: 'Gürkan Bey, EasyGulet\'e premium motoryat katmanı',
      personalization_hook: 'EasyGulet frankofon misafire zaten denizi satıyor — motoryat tamamlayıcı katman',
      ideal_format: 'Frankofon VIP/incentive motoryat Boğaz; Bodrum/Fethiye event yacht alternatif; 10-30 kişi corporate retreat',
      special_offer_expiry: '2026-08-04',
    },
  },
  {
    company_name: 'myGO Worldwide',
    legal_name: 'myGO Turizm Teknoloji',
    primary_contact_name: 'Fatih Alp',
    primary_contact_role: 'General Manager (Türkiye Country Manager)',
    primary_contact_email: 'fatih@mygo.pro',
    primary_contact_phone: '+90 544 912 40 10',
    website: 'https://mygo.pro',
    city: 'İstanbul',
    country: 'TR',
    type: 'ota',
    segment: 'ota',
    temperature: 'hot',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p1', 'warmup-sal', 'segment-ota-retail', 'segment-dmc', 'decision-role-decision-maker', 'b2b-platform'],
    notes: 'Tier 1 — 2011 Brüksel HQ, 7 ülke (BE/TN/DZ/MA/TR/OM/CI + Barcelona), ~140 kişi global. 470K+ otel, 250+ aktivite supplier, B2B BedBank. Frankofon Mağrip + Körfez + Sub-Saharan ağ. Fatih Alp ex-Intra Tours DMC + MBA. SDK/XML platform — Concierge Connect API ile eşleşme potansiyeli. LinkedIn: linkedin.com/in/fatih-alp-a4a22734',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'sal-2026-06-09',
      send_time_tr: '10:40',
      mail_subject: 'Fatih Bey, 250+ aktivite supplier yapısı — Constantine',
      personalization_hook: '7 ülke + 250+ aktivite supplier B2B platform yapısı',
      ideal_format: 'Boğaz half-day shared cruise (60-80 EUR/pax) + private charter 12-80 kişi — 2 SKU',
      linkedin_personal: 'https://tr.linkedin.com/in/fatih-alp-a4a22734',
      linkedin_company: 'https://be.linkedin.com/company/mygo-worldwide',
      special_offer_expiry: '2026-08-04',
    },
  },

  // === ÇAR 2026-06-10 (4 — Tier 1 + Tier 2) ===
  {
    company_name: 'Jolly Tur',
    legal_name: 'Club Jolly Turizm ve Ticaret A.Ş.',
    primary_contact_name: 'Atakan Güllecioğlu',
    primary_contact_role: 'Acenta Müdürü (Sales Department)',
    primary_contact_email: 'a.gullecioglu@jollytur.com',
    primary_contact_phone: '+90 533 137 07 60',
    website: 'https://www.jollytur.com/',
    city: 'İstanbul',
    country: 'TR',
    type: 'ota',
    segment: 'ota',
    temperature: 'hot',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p1', 'warmup-car', 'segment-ota-retail', 'segment-mice', 'segment-kurumsal'],
    notes: 'Tier 1 — 1987 kuruluş, Türkiye\'nin EN BÜYÜK perakende acentelerinden, 600+ satış noktası, 3500 kişi. 3 KAPI: (1) Jolly MICE — gala/lansman/yıl sonu; (2) Jolly Kurumsal 80+ B2B müşteri; (3) 600+ acente network white-label. STRATEJİ: Atakan üzerinden Jolly MICE\'a (Tolga Özakhun) warm intro iste.',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'car-2026-06-10',
      send_time_tr: '10:00',
      mail_subject: 'Atakan Bey, Jolly MICE köprüsü için — Constantine',
      personalization_hook: 'Jolly MICE\'ın gala/lansman/yıl sonu portföyü — Constantine ile birebir match',
      ideal_format: '80-120 kişi kurumsal gala Boğaz + 600+ acente network beyaz-etiket reseller',
      strategy: 'Atakan üzerinden Jolly MICE warm intro iste — Tolga Özakhun karar verici',
      linkedin_company: 'https://tr.linkedin.com/company/jolly-tur',
      special_offer_expiry: '2026-08-04',
    },
  },
  {
    company_name: 'Zesa Travel (İstanbul)',
    legal_name: 'Zesa Turizm Seyahat Ticaret A.Ş.',
    primary_contact_name: 'Yeşim Özalp',
    primary_contact_role: 'Acenta Müdürü',
    primary_contact_email: 'yesim@zesatravel.com',
    primary_contact_phone: '+90 212 224 46 40',
    website: 'http://zesatravel.com/',
    city: 'İstanbul',
    country: 'TR',
    type: 'ota',
    segment: 'ota',
    temperature: 'warm',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p2', 'warmup-car', 'segment-ota-retail', 'segment-karma'],
    notes: 'Tier 2 — 1998 İstanbul + 2008 Berlin çift ofis. Nişantaşı/Şişli HQ. Karma müşteri (bireysel + kurumsal). UYARI: Aynı gün Kezban Hanım (Berlin) ayrı mail — bu mailde referans var.',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'car-2026-06-10',
      send_time_tr: '10:00',
      mail_subject: 'Yeşim Hanım, İstanbul operasyonu — Constantine',
      personalization_hook: '1998 İstanbul + 2008 Berlin çift ofis — Türkiye operasyon',
      ideal_format: '20-50 kişi Almanya-merkezli Türk diaspora özel günü Boğaz',
      pair_with: 'Kezban Çuhadar Kayalı (Zesa Berlin) — aynı gün ayrı mail',
      special_offer_expiry: '2026-08-04',
    },
  },
  {
    company_name: 'Zesa Travel (Berlin)',
    legal_name: 'Zesa Turizm Seyahat Ticaret A.Ş. (Berlin ofis)',
    primary_contact_name: 'Kezban Çuhadar Kayalı',
    primary_contact_role: 'Founder/CEO',
    primary_contact_email: 'kezban@zesatravel.com',
    primary_contact_phone: '+49 179 900 86 05',
    website: 'http://zesatravel.com/',
    city: 'Berlin',
    country: 'DE',
    type: 'ota',
    segment: 'ota',
    temperature: 'warm',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p2', 'warmup-car', 'segment-ota-retail', 'segment-diaspora', 'decision-role-decision-maker'],
    notes: 'Tier 2 — Berlin ofisi (Mariendorfer Damm 60). 27 yıl IATA. Türk diasporası + Alman kurumsal. UYARI: LinkedIn soyadı "Çuhadar Kayalı" (kart eksik "Kayalı"). SAAT: TR 11:30 = DE 09:30 Berlin açılış. LinkedIn: de.linkedin.com/in/kezban-cuhadar-kayali-77953b13',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'car-2026-06-10',
      send_time_tr: '11:30',
      send_time_de: '09:30',
      mail_subject: 'Kezban Hanım, Berlin\'den İstanbul\'a kurumsal yat — Constantine',
      personalization_hook: '27 yıl IATA + Berlin ofisi 2008\'den beri — Almanca diaspora kanalı',
      ideal_format: '20-50 kişi Türk diaspora aile/kurumsal özel günü Boğaz',
      data_correction: 'LinkedIn soyadı Çuhadar Kayalı (kart sadece Kayalı eksikti)',
      linkedin_personal: 'https://de.linkedin.com/in/kezban-cuhadar-kayali-77953b13',
      pair_with: 'Yeşim Özalp (Zesa İstanbul) — aynı gün ayrı mail',
      special_offer_expiry: '2026-08-04',
    },
  },
  {
    company_name: 'Ottoman HT',
    legal_name: 'OttomanHT Sağlık Hizmetleri Turizm İç ve Dış Tic. Ltd. Şti.',
    primary_contact_name: 'İsmail Hacıosman',
    primary_contact_role: 'Founder (aile şirketi — Ismet+Muharrem Hacıosman da görevli)',
    primary_contact_email: 'info@ottoman-ht.com',
    primary_contact_phone: '+90 534 033 45 14',
    website: 'https://ottoman-ht.com',
    city: 'İstanbul',
    country: 'TR',
    type: 'other',
    segment: 'other',
    temperature: 'warm',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p2', 'warmup-car', 'segment-saglik-turizmi', 'segment-korfez'],
    notes: 'Tier 2 — 2019 kuruluş, aile şirketi. Sağlık turizmi (HT=Health Tourism). 4 dil + Arapça tercüman. Avrupa + Körfez + Frankofon Afrika incoming. Saç ekimi entry. Avrupa Türk medyası (ATV) bağlantı.',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'car-2026-06-10',
      send_time_tr: '10:25',
      mail_subject: 'İsmail Bey, Körfez sağlık turisti recovery — Constantine',
      personalization_hook: 'Çok dilli yapı + Körfez/Avrupa hasta portföyü — Arapça tercümanlık',
      ideal_format: '6-10 kişi Körfez/Arap hasta+aile "İstanbul Welcome" yarım gün Boğaz (saç ekimi sonrası 3. gün)',
      linkedin_company: 'https://www.linkedin.com/company/ottomanht',
      special_offer_expiry: '2026-08-04',
    },
  },

  // === PER 2026-06-11 (5 — Tier 2 sağlık + diğer) ===
  {
    company_name: 'Ayfa Clinic',
    legal_name: 'Ayfa Sağlık Hizmetleri Danışmanlığı Ltd. Şti.',
    primary_contact_name: 'Fahri Açar',
    primary_contact_role: 'Kurucu Ortak',
    primary_contact_email: 'info@ayfaclinic.com',
    primary_contact_phone: '+90 542 775 88 87',
    website: 'https://ayfaclinic.com',
    city: 'İstanbul',
    country: 'TR',
    type: 'other',
    segment: 'other',
    temperature: 'warm',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p2', 'warmup-per', 'segment-saglik-turizmi'],
    notes: 'Tier 2 — 2019 kuruluş, TÜRSAB 13224. Şişli/Nişantaşı + Fulya. Bariatrik (Fahri Açar uzmanlık) + plastik + diş + jinekoloji. "Salud Estambul" İspanyol pazar markası. Site dilleri TR/EN/ES/DE/IT. LinkedIn: linkedin.com/in/fahri-açar-47701b137',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'per-2026-06-11',
      send_time_tr: '10:00',
      mail_subject: 'Fahri Bey, refakatçi memnuniyet programı — Constantine',
      personalization_hook: 'Bariatrik+estetik + Salud Estambul İspanyol pazar açısı',
      ideal_format: '4-8 kişi refakatçi grubu 3 saatlik Boğaz öğle (ameliyat günü)',
      brand_split: 'Ayfa Clinic (genel/İngilizce) + Salud Estambul (İspanyol pazar)',
      linkedin_personal: 'https://www.linkedin.com/in/fahri-açar-47701b137/',
      special_offer_expiry: '2026-08-04',
    },
  },
  {
    company_name: 'Mednificant',
    legal_name: 'Şansel Kavlakoğlu Sağlık Hizmetleri Ltd. Şti. (kart: Kavlakoğlu Kliniği)',
    primary_contact_name: 'Şansel Kavlakoğlu',
    primary_contact_role: 'Kurucu / İşletmeci (DOKTOR DEĞİL — sözleşmeli doktorlar var)',
    primary_contact_email: 'info@mednificant.com',
    primary_contact_phone: '+90 532 381 19 59',
    website: 'https://mednificant.com',
    city: 'Nurol Tower Şişli/İstanbul',
    country: 'TR',
    type: 'other',
    segment: 'other',
    temperature: 'warm',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p2', 'warmup-per', 'segment-saglik-turizmi', 'segment-butik', 'decision-role-decision-maker'],
    notes: 'Tier 2 — KARTVİZIT YANILTICI: "Kavlakoğlu Kliniği" yazılı ama gerçek marka MEDNIFICANT. Şansel Hanım DOKTOR DEĞİL — sağlık turizmi acentesi sahibi. Ameliyatları sözleşmeli doktorlar yapıyor (Dr. Burak Kavlakoğlu — aile bağı, ortak telefon). Butik concierge model. Balkanlar (site /sq/ Arnavutça) + Körfez + Frankofon. UYARI: "Doktor" hitabı KULLANMA — "Şansel Hanım". Web sanselkavlakoglu.com SSL süresi dolmuş.',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'per-2026-06-11',
      send_time_tr: '10:12',
      mail_subject: 'Şansel Hanım, refakatçi recovery half-day — Constantine',
      personalization_hook: 'Butik tarz + hastayla birebir ilgilenme şekli',
      ideal_format: '8-12 kişi (hasta+refakatçi) yarım gün Boğaz recovery (dinlenme öncelikli), İstanbul rıhtım',
      brand_correction: 'Kart "Kavlakoğlu Kliniği" — gerçek marka MEDNIFICANT',
      hitap_uyarisi: 'Şansel Hanım DOKTOR DEĞİL — işletmeci. "Doktor" hitabı kullanma.',
      web_issue: 'sanselkavlakoglu.com SSL süresi dolmuş — kullanılabilir vitrin mednificant.com',
      special_offer_expiry: '2026-08-04',
    },
  },
  {
    company_name: 'AN Turizm (Cityline Travel)',
    legal_name: 'Cityline Travel An Turizm (NOT: Doğuş Grubu Antur Turizm A.Ş. DEĞİL)',
    primary_contact_name: 'Adem Atilgan',
    primary_contact_role: 'Co-Founder',
    primary_contact_email: 'info@anturizm.com',
    primary_contact_phone: '+90 532 334 36 69',
    website: 'https://anturizm.com',
    city: 'İstanbul',
    country: 'TR',
    type: 'agency',
    segment: 'other',
    temperature: 'warm',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p2', 'warmup-per', 'segment-kurumsal-acente', 'segment-alman'],
    notes: 'Tier 2 — Butik kurumsal seyahat. Adem Atilgan ex-Lufthansa + Hochschule Karlsruhe MBA. Alman pazar köprüsü potansiyeli. UYARI: Cityline Travel = AYRI firma, Doğuş Grubu Antur Turizm A.Ş. ile karıştırma. SSL süresi dolmuş. LinkedIn: tr.linkedin.com/in/adem-atilgan-562a9481',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'per-2026-06-11',
      send_time_tr: '10:25',
      mail_subject: 'Adem Bey, Alman butik kurumsal — Constantine',
      personalization_hook: 'Lufthansa geçmişi + butik kurumsal seyahat odağı',
      ideal_format: '20-50 kişi Alman kurumsal welcome dinner/küçük gala Boğaz',
      data_correction: 'Soyad Atilgan (kart eksik). Cityline Travel ≠ Doğuş Antur. SSL süresi dolmuş.',
      linkedin_personal: 'https://tr.linkedin.com/in/adem-atilgan-562a9481',
      linkedin_company: 'https://www.linkedin.com/company/cityline-travel-an-turizm',
      special_offer_expiry: '2026-08-04',
    },
  },
  {
    company_name: 'Holy Turizm',
    primary_contact_name: 'Emre Kutlu',
    primary_contact_role: 'Founder',
    primary_contact_email: 'emre@holyturizm.com',
    primary_contact_phone: '+90 553 877 21 78',
    website: 'https://www.holyturizm.com/',
    city: 'Şişli/İstanbul',
    country: 'TR',
    type: 'ota',
    segment: 'ota',
    temperature: 'warm',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p3', 'warmup-per', 'segment-ota-retail', 'decision-role-decision-maker'],
    notes: 'Tier 3 — 2023 doğumlu küçük mass-market retail. TÜRSAB 9711. "Ekonomik tatil" tagline. Mert tier 1 sanıyordu ama gerçek tier 3. Founder ile temas sıcak ama satış volümü düşük. Uzun vadeli ilişki, hızlı kapanış bekleme.',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'per-2026-06-11',
      send_time_tr: '10:40',
      mail_subject: 'Emre Bey, özel gün paketleri — Constantine',
      personalization_hook: 'Yeni kurulmuş + doğru product mix arıyor',
      ideal_format: '12-30 kişi özel gün kapsül paketler (sürpriz teklif, küçük kına, doğum günü)',
      tier_note: 'Mert "tier 1 sanıyordu" — gerçek tier 3 (mass market, küçük volume)',
      special_offer_expiry: '2026-08-04',
    },
  },
  {
    company_name: 'Tatilciniz Turizm',
    primary_contact_name: 'Emre Gülaçtı',
    primary_contact_role: 'Founder / CEO',
    primary_contact_email: 'info@tatilciniz.com.tr',
    primary_contact_phone: '+90 532 055 64 95',
    website: 'https://tatilciniz.com.tr',
    city: 'Mecidiyeköy/Şişli',
    country: 'TR',
    type: 'ota',
    segment: 'ota',
    temperature: 'warm',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p3', 'warmup-per', 'segment-ota-retail'],
    notes: 'Tier 3 — 2018 kuruluş, küçük B2C OTA. TURSAB A-11199. Yurtiçi otobüslü/uçaklı + yurtdışı Balkan/Avrupa/Mısır/Dubai. Mass-to-mid market. Reseller/komisyon kanalı için uygun. LinkedIn: tr.linkedin.com/in/emre-gülaçtı-8932161aa',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'per-2026-06-11',
      send_time_tr: '11:00',
      mail_subject: 'Emre Bey, Bodrum paketlerinize yat günü add-on',
      personalization_hook: 'Bodrum-Marmaris yurtiçi paket ağırlığı — yat günü add-on',
      ideal_format: '12-25 kişi günübirlik motoryat Bodrum/Fethiye/Marmaris paketlerine add-on',
      linkedin_personal: 'https://tr.linkedin.com/in/emre-gülaçtı-8932161aa',
      linkedin_company: 'https://www.linkedin.com/company/tatilciniz-turizm',
      special_offer_expiry: '2026-08-04',
    },
  },

  // === CUM 2026-06-12 (2 — Discovery) ===
  {
    company_name: 'Karadağ Turizm',
    primary_contact_name: 'Hüseyin Karadağ',
    primary_contact_role: 'General Manager',
    primary_contact_email: 'huseyin@karadagturizm.com.tr',
    primary_contact_phone: '+90 533 050 63 02',
    website: null,
    city: 'İstanbul',
    country: 'TR',
    type: 'other',
    segment: 'other',
    temperature: 'cold',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p3', 'warmup-cum', 'segment-belirsiz', 'discovery'],
    notes: 'BELİRSİZ — DISCOVERY MAIL. Web ECONNREFUSED (karadagturizm.com.tr sunucu yok). LinkedIn izi yok. Hüseyin Karadağ adı yaygın. Mail "anlama" tonunda — "satıcı" değil. Segment netleştikten sonra spesifik teklif.',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'cum-2026-06-12',
      send_time_tr: '10:00',
      mail_subject: 'Hüseyin Bey, kısa tanışma — Constantine',
      personalization_hook: 'Tanıma fırsatı bulamadık — keşif',
      mail_strategy: 'DISCOVERY — generic değer önerisi minimal, segment sorusu öne çıkar',
      data_issue: 'Web ECONNREFUSED, LinkedIn yok, NeverBounce ile pre-check yap',
    },
  },
  {
    company_name: 'hum sağlık',
    primary_contact_name: 'Halil Mercan',
    primary_contact_role: 'Director',
    primary_contact_email: 'halilmercan0720@gmail.com',
    primary_contact_phone: '+90 505 039 07 07',
    website: null,
    city: 'İstanbul',
    country: 'TR',
    type: 'other',
    segment: 'other',
    temperature: 'cold',
    tags: ['agent-day-2026-06-04', 'tier-1-onboarded', 'priority-p3', 'warmup-cum', 'segment-saglik-turizmi', 'discovery'],
    notes: 'BELİRSİZ — DISCOVERY MAIL. Kişisel Gmail (kurumsal mail yok). Web bulunamadı. Sağlık turizmi tahmini. Mailda nazikçe kurumsal mail/web sor. Volume bilinmiyor.',
    custom_fields: {
      event_id: 'agent-day-2026-06-04',
      warmup_day: 'cum-2026-06-12',
      send_time_tr: '10:12',
      mail_subject: 'Halil Bey, kısa tanışma — sağlık turizmi',
      personalization_hook: 'Sağlık turizmi tarafında keşif — pazar+prosedür+kurumsal mail sor',
      mail_strategy: 'DISCOVERY — kurumsal mail+web sor, segment netleştir',
      data_issue: 'Kişisel Gmail kullanıyor — kurumsal mail sorgulanacak',
    },
  },
];

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
const MODE = (process.argv[2] ?? 'dry').toLowerCase();

async function superAdminId(): Promise<string> {
  const rows = await sql`SELECT id FROM profiles WHERE role='super_admin' AND active=true ORDER BY created_at LIMIT 1`;
  if (!rows[0]?.id) throw new Error('super_admin profil bulunamadı');
  return rows[0].id;
}

async function ensureCampaign(adminId: string): Promise<string> {
  const found = await sql`SELECT id FROM campaigns WHERE name=${CAMPAIGN_NAME} LIMIT 1`;
  if (found[0]?.id) {
    console.log(`📋 Mevcut campaign bulundu: ${found[0].id}`);
    return found[0].id;
  }
  const ins = await sql`
    INSERT INTO campaigns (
      name, description, channel, sender_email, status, daily_cap, created_by,
      warmup_enabled, send_window_start, send_window_end, send_days,
      min_gap_seconds, random_gap_seconds
    )
    VALUES (
      ${CAMPAIGN_NAME},
      ${CAMPAIGN_DESC},
      'email',
      ${SENDER_EMAIL},
      'draft',
      20,
      ${adminId},
      true,
      '10:00',
      '17:30',
      ARRAY[1,2,3,4,5]::int[],
      45,
      90
    )
    RETURNING id
  `;
  console.log(`✨ Yeni campaign yaratıldı (draft): ${ins[0].id}`);
  return ins[0].id;
}

async function upsertLead(lead: LeadInput): Promise<{ id: string; created: boolean }> {
  const existing = await sql`
    SELECT id FROM leads
    WHERE lower(primary_contact_email) = lower(${lead.primary_contact_email})
    LIMIT 1
  `;
  if (existing[0]?.id) {
    // C seçeneği — SADECE BOŞ ALANLARI DOLDUR, mevcut veriyi ASLA ezme.
    // NeverBounce / Places enrich validation chain'i korunur.
    // Temperature: Agent Day taze, güncelle. Tags/notes/custom_fields: birleştir.
    await sql`
      UPDATE leads SET
        primary_contact_name  = COALESCE(NULLIF(primary_contact_name, ''),  ${lead.primary_contact_name}),
        primary_contact_role  = COALESCE(NULLIF(primary_contact_role, ''),  ${lead.primary_contact_role}),
        primary_contact_phone = COALESCE(NULLIF(primary_contact_phone, ''), ${lead.primary_contact_phone}),
        website  = COALESCE(NULLIF(website, ''),  ${lead.website ?? null}),
        city     = COALESCE(NULLIF(city, ''),     ${lead.city ?? null}),
        legal_name = COALESCE(NULLIF(legal_name, ''), ${lead.legal_name ?? null}),
        tags = (
          SELECT array_agg(DISTINCT t) FROM unnest(coalesce(tags, '{}') || ${lead.tags}::text[]) t
        ),
        notes = CASE
          WHEN notes IS NULL OR notes = '' THEN ${lead.notes}
          ELSE notes || E'\n\n--- Agent Day 2026-06-04 ---\n' || ${lead.notes}
        END,
        custom_fields = coalesce(custom_fields, '{}'::jsonb) || ${sql.json(lead.custom_fields)},
        source = COALESCE(NULLIF(source, ''), ${SOURCE}),
        temperature = ${lead.temperature}::lead_temperature,
        updated_at = NOW()
      WHERE id = ${existing[0].id}
    `;
    return { id: existing[0].id, created: false };
  }
  const ins = await sql`
    INSERT INTO leads (
      company_name, legal_name,
      primary_contact_name, primary_contact_role, primary_contact_email, primary_contact_phone,
      website, city, country,
      type, segment, status, source,
      tags, temperature, notes, custom_fields
    )
    VALUES (
      ${lead.company_name}, ${lead.legal_name ?? null},
      ${lead.primary_contact_name}, ${lead.primary_contact_role}, ${lead.primary_contact_email}, ${lead.primary_contact_phone},
      ${lead.website ?? null}, ${lead.city ?? null}, ${lead.country ?? 'TR'},
      ${lead.type}::lead_type, ${lead.segment}::lead_segment, 'new'::lead_status, ${SOURCE},
      ${lead.tags}::text[], ${lead.temperature}::lead_temperature, ${lead.notes},
      ${sql.json(lead.custom_fields)}
    )
    RETURNING id
  `;
  return { id: ins[0].id, created: true };
}

async function ensureTarget(campaignId: string, leadId: string): Promise<boolean> {
  const existing = await sql`
    SELECT id FROM campaign_targets WHERE campaign_id=${campaignId} AND lead_id=${leadId} LIMIT 1
  `;
  if (existing[0]?.id) return false;
  await sql`
    INSERT INTO campaign_targets (campaign_id, lead_id, status)
    VALUES (${campaignId}, ${leadId}, 'queued')
  `;
  return true;
}

async function logActivity(adminId: string, eventType: string, leadIds: string[], extra: Record<string, any> = {}): Promise<void> {
  for (const leadId of leadIds) {
    try {
      await sql`
        INSERT INTO activity_events (user_id, event_type, points, category, target_type, target_id, metadata)
        VALUES (${adminId}, ${eventType}, 0, 'standard', 'lead', ${leadId}, ${sql.json({ source: SOURCE, ...extra })})
      `;
    } catch {
      /* activity_events şeması farklıysa sessizce geç */
    }
  }
}

async function cleanup(): Promise<void> {
  console.log(`🧹 Cleanup: source='${SOURCE}' tüm Agent Day verileri silinecek...\n`);
  const campaigns = await sql`SELECT id FROM campaigns WHERE name=${CAMPAIGN_NAME}`;
  const campaignIds = campaigns.map((r: any) => r.id);
  const leads = await sql`SELECT id FROM leads WHERE source=${SOURCE}`;
  const leadIds = leads.map((r: any) => r.id);

  for (const cid of campaignIds) {
    await sql`DELETE FROM email_events WHERE message_id IN (SELECT id FROM email_messages WHERE campaign_id=${cid})`;
    await sql`DELETE FROM email_messages WHERE campaign_id=${cid}`;
    await sql`DELETE FROM campaign_targets WHERE campaign_id=${cid}`;
    await sql`DELETE FROM campaign_warmup_state WHERE campaign_id=${cid}`;
    await sql`DELETE FROM campaigns WHERE id=${cid}`;
  }
  if (leadIds.length) {
    await sql`DELETE FROM email_messages WHERE thread_id IN (SELECT id FROM email_threads WHERE lead_id = ANY(${leadIds}))`;
    await sql`DELETE FROM email_threads WHERE lead_id = ANY(${leadIds})`;
    await sql`DELETE FROM campaign_targets WHERE lead_id = ANY(${leadIds})`;
    await sql`DELETE FROM leads WHERE id = ANY(${leadIds})`;
  }
  console.log(`✅ Silindi: ${leadIds.length} lead, ${campaignIds.length} campaign.`);
}

async function main() {
  if (MODE === 'cleanup') {
    await cleanup();
    await sql.end();
    return;
  }

  console.log(`\n=== SEED AGENT DAY LEADS — mod: ${MODE.toUpperCase()} ===`);
  console.log(`Source tag: ${SOURCE}`);
  console.log(`Campaign: "${CAMPAIGN_NAME}"`);
  console.log(`Lead sayısı: ${LEADS.length}\n`);

  if (MODE !== 'upsert') {
    console.log('DRY mod — DB\'ye yazılmadı. Gerçek upsert için:');
    console.log('  npx tsx scripts/seed-agent-day-leads.mts upsert\n');
    console.log('Lead listesi:');
    LEADS.forEach((l, i) => {
      console.log(`  ${String(i + 1).padStart(2, ' ')}. [${l.tags.find(t => t.startsWith('warmup-')) ?? '?'}] ${l.company_name} — ${l.primary_contact_name} (${l.primary_contact_email}) — ${l.temperature}`);
    });
    await sql.end();
    return;
  }

  const adminId = await superAdminId();
  console.log(`👤 super_admin: ${adminId}\n`);

  const campaignId = await ensureCampaign(adminId);

  let created = 0, updated = 0, targeted = 0;
  const newLeadIds: string[] = [];
  for (const lead of LEADS) {
    const { id, created: isNew } = await upsertLead(lead);
    if (isNew) {
      created++;
      newLeadIds.push(id);
    } else {
      updated++;
    }
    const wasTargeted = await ensureTarget(campaignId, id);
    if (wasTargeted) targeted++;
    console.log(`  ${isNew ? '➕' : '🔄'} ${lead.company_name.padEnd(45)} → ${id.slice(0, 8)}…  [${wasTargeted ? 'target+' : 'target='}]`);
  }

  if (newLeadIds.length) {
    await logActivity(adminId, 'lead_added', newLeadIds, {
      source: SOURCE,
      campaign_id: campaignId,
      script: 'seed-agent-day-leads.mts',
    });
  }

  console.log(`\n📊 Özet:`);
  console.log(`  • Yeni lead       : ${created}`);
  console.log(`  • Güncellenen lead: ${updated}`);
  console.log(`  • Toplam target   : ${targeted}`);
  console.log(`  • Campaign        : ${campaignId} (status='draft')\n`);

  console.log(`🔍 Doğrulama sorgusu:`);
  console.log(`  SELECT count(*) FROM leads WHERE source='${SOURCE}';`);
  console.log(`  SELECT count(*) FROM campaign_targets WHERE campaign_id='${campaignId}';\n`);

  console.log(`✅ Tamam. Campaign 'draft' modunda — Mert manuel launch edecek.`);
  console.log(`   Launch için (Pzt 2026-06-08 başlangıç önerisi):`);
  console.log(`     UPDATE campaigns SET status='running', started_at=now() WHERE id='${campaignId}';`);

  await sql.end();
}

main().catch((err) => {
  console.error('❌ HATA:', err);
  process.exit(1);
});
