#!/usr/bin/env node
/**
 * KIMLIK KURALLARI TESTI — her vaka 26 Agustos 2026'da GERCEKTEN yasanmis bir hatadir.
 * lib/kimlik.mjs degistirildiginde once bu kosulur.  node kimlik-testleri.mjs
 */
import { adAlanEslesmesi, beyanEslesmesi, degistirmeliMi, tokenlar } from './lib/kimlik.mjs';

let gecen=0, kalan=0;
const t=(ad,olan,olmasi)=>{
  const ok = JSON.stringify(olan)===JSON.stringify(olmasi);
  if(ok) gecen++; else { kalan++; console.log(`  ✗ ${ad}\n      beklenen: ${JSON.stringify(olmasi)}\n      cikan   : ${JSON.stringify(olan)}`); }
};

console.log('— ad <-> alan adi —');
// HATA 1/3: 'jbr' 3 harf diye elenmisti, iki dosyada iki farkli sikilik vardi
t('JBR TURIZM -> jbrtravel.com', adAlanEslesmesi('JBR TURİZM','jbrtravel.com'), 'tam');
t('TATILISTE -> tatiliste.com', adAlanEslesmesi('TATİLİSTE TURİZM','tatiliste.com'), 'tam');
t('AKGE -> ilgiseyahat.com (yanlis firma)', adAlanEslesmesi('AKGE TURİZM','ilgiseyahat.com'), 'yok');
// HATA 7: jenerik kelime ayirt edici sayilmisti
t('BENTE WORLD -> worldtur.com REDDET', adAlanEslesmesi('BENTE WORLD TRAVEL AGENCY','worldtur.com'), 'yok');
t('BIG EAGLE -> bigtravel.com REDDET', adAlanEslesmesi('BIG EAGLE TOUR TRAVEL','bigtravel.com'), 'yok');
t('NOVA WORLD -> novaromatravel.com REDDET', adAlanEslesmesi('NOVA WORLD TRAVEL AGENCY','novaromatravel.com'), 'yok');
t('jenerik kelimeler token olmamali', tokenlar('GLOBAL WORLD ELITE TURİZM LTD ŞTİ'), []);

console.log('— site beyani —');
// v1 yanlis EVET: alt-dize eslesmesi
t('SANTE PRIVEE <-> LOSANTE REDDET', beyanEslesmesi('SANTE PRIVEE TRAVEL AGENCY','LÖSANTE'), false);
// v1 yanlis HAYIR: bosluk farki
t('YESEVITUR <-> "Yesevi Tur"', beyanEslesmesi('YESEVİTUR SEYAHAT ACENTASI','Yesevi Tur'), true);
t('BLUEROUTE <-> "Blue Route"', beyanEslesmesi('BLUEROUTE TRAVEL TURİZM','Blue Route Turizm'), true);
t('FIBOTRAVEL <-> "Fibo Travel"', beyanEslesmesi('FİBOTRAVEL MEDICAL','Fibo Travel'), true);
t('MILLTOWN <-> "MillTown Paper" kimlik TUTAR', beyanEslesmesi('MILLTOWN TRAVEL','MillTown Paper'), true);
t('alakasiz beyan REDDET', beyanEslesmesi('ZEYHAN TURİZM','Zeyhan Elektrik - Tasarım'), true);

console.log('— adres degistirme korumalari —');
// HATA 2: 57 gerileme
t('H1 eski zaten firmanin alaninda',
  degistirmeliMi('TRAVEL BY POWER','gucseyahat@travelbypower.com.tr','info@thabtravel.com').degistir, false);
t('H2a isimli kisi -> jenerik ENGELLE',
  degistirmeliMi('GENÇ GÜÇLÜ','yasin@gencgucluturizm.com.tr','info@gencgucluturizm.com.tr').degistir, false);
t('H2b jenerik -> isimli kisi IZIN',
  degistirmeliMi('EKOMANIA TURİZM','bilgi@ekomania.com.tr','ergun@ekomania.com.tr').degistir, true);
t('gercek duzeltme IZIN',
  degistirmeliMi('BALLİ TURİZM','ibrahim.bal@socialevents.com.tr','info@balliturizm.com.tr').degistir, true);
t('bos eskiden yeniye IZIN',
  degistirmeliMi('X TURİZM','','info@xturizm.com').degistir, true);
t('ayni adres degisim YOK',
  degistirmeliMi('X TURİZM','info@x.com','info@x.com').degistir, false);

// 26 Agu — GOREV 2-B denetiminde cikan yanlis-red: FCM TRAVEL SOLUTIONS -> fcmtravel.com
t('FCM TRAVEL SOLUTIONS -> fcmtravel', adAlanEslesmesi('FCM TRAVEL SOLUTIONS TURİZM','fcmtravel.com'), 'tam');
t('JBR (sesli harfsiz kisaltma) korunuyor', adAlanEslesmesi('JBR TURİZM','jbrtravel.com'), 'tam');
t('BIG EAGLE TOUR -> bigtravel hala RED', adAlanEslesmesi('BIG EAGLE TOUR','bigtravel.com'), 'yok');
t('ATA JOURNEY -> gravitetravel RED', adAlanEslesmesi('ATA JOURNEY TURİZM','gravitetravel.com'), 'yok');
t('kisaltma + JENERIK OLMAYAN son ek RED', adAlanEslesmesi('XYZ TURİZM','xyzbeyoglu.com'), 'yok');

// 26 Agu — GOREV 2-B: alan adinda FAZLADAN ayirt edici kelime varsa baska firmadir
// 'kismi' = ortusme var ama kanit yetmez; karar kapilari yalnizca 'tam' kabul eder
t('SEVEN WALKER -> sevenhillstravelgroup TAM DEGIL', adAlanEslesmesi('SEVEN WALKER TURİZM','sevenhillstravelgroup.com'), 'kismi');
t('DREAM PATH -> dreamistanbultravel KABUL', adAlanEslesmesi('DREAM PATH TRAVEL AGENCY','dreamistanbultravel.com'), 'tam');
t('BABUNEC -> babunectravel KABUL', adAlanEslesmesi('BABUNEC TRAVEL','babunectravel.com'), 'tam');
t('ALEA -> aleaholidays KABUL', adAlanEslesmesi('ALEA TRAVEL','aleaholidays.com'), 'tam');

// 26 Agu — jenerik siyirma sirasi: 'tur' onden gidince 'tourism'den geriye 'ism' kaliyordu
t('A-LEVEL TOURISM -> a-leveltourism', adAlanEslesmesi('A-LEVEL TOURISM','a-leveltourism.com'), 'tam');
// firmanin TUM ayirt edici kelimeleri alan adindaysa fazladan kelime kusur degil
t('ALİ GÜNEŞ TURİZM -> aligunesagizvedis', adAlanEslesmesi('ALİ GÜNEŞ TURİZM','aligunesagizvedis.com'), 'tam');
t('SEVEN WALKER hala TAM DEGIL', adAlanEslesmesi('SEVEN WALKER TURİZM','sevenhillstravelgroup.com'), 'kismi');
t('BIG EAGLE hala RED', adAlanEslesmesi('BIG EAGLE TOUR','bigtravel.com'), 'yok');
t('FABULOUS -> holidayturkeytours RED', adAlanEslesmesi('FABULOUS TRAVEL','holidayturkeytours.com'), 'yok');
// Zincir markasi ad olarak GERCEKTEN eslesir ('hilton' = hilton.com) — burasi 'tam' demeli.
// Zincir sorununu baska katman cozer: render-karar.mjs'in PAYLASILAN SITE kurali,
// ayni siteyi 18 otel sahiplendigi ve birden cogu eslestigi icin hepsini reddeder.
t('DoubleTree by Hilton -> hilton.com ad olarak TUTAR', adAlanEslesmesi('DoubleTree by Hilton Istanbul Moda','hilton.com'), 'tam');

console.log(`\n${gecen} gecti, ${kalan} kaldi`);
process.exit(kalan ? 1 : 0);
