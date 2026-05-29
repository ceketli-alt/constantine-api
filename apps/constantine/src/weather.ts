/**
 * weather.ts — Open-Meteo forecast helper (no API key required)
 *
 * - getDailyForecast(lat, lon, days) → bugün + yarın (default İstanbul)
 * - formatWeatherShort(forecast) → "⛅ 24°C → 18°C · Rüzgar 12 km/h"
 *
 * WMO weather codes: https://open-meteo.com/en/docs#weathervariables
 *
 * 5-dakika in-memory cache (eviction-free, küçük TTL) — digest render sırasında
 * birden fazla recipient için aynı cevap kullanılır.
 */

const WEATHER_BASE = process.env.WEATHER_BASE_URL ?? 'https://api.open-meteo.com/v1/forecast';

// Constantine ofis lokasyonu (İstanbul, default fallback)
const DEFAULT_LAT = Number(process.env.WEATHER_DEFAULT_LAT ?? '41.0082');
const DEFAULT_LON = Number(process.env.WEATHER_DEFAULT_LON ?? '28.9784');
const DEFAULT_TZ = process.env.WEATHER_DEFAULT_TZ ?? 'Europe/Istanbul';

export interface DayForecast {
  dateIso: string;          // YYYY-MM-DD
  weatherCode: number;      // WMO code
  tempMax: number;          // °C
  tempMin: number;          // °C
  windMaxKmh: number;
  precipMm: number;
  emoji: string;
  labelTr: string;
}

export interface WeatherSnapshot {
  today: DayForecast | null;
  tomorrow: DayForecast | null;
  fetchedAt: string;
  fromCache: boolean;
}

// =========================================================
// WMO code → emoji + Türkçe label
// =========================================================
function weatherCodeMeta(code: number): { emoji: string; labelTr: string } {
  if (code === 0) return { emoji: '☀️', labelTr: 'Açık' };
  if (code === 1) return { emoji: '🌤️', labelTr: 'Çoğunlukla açık' };
  if (code === 2) return { emoji: '⛅', labelTr: 'Parçalı bulutlu' };
  if (code === 3) return { emoji: '☁️', labelTr: 'Bulutlu' };
  if (code === 45 || code === 48) return { emoji: '🌫️', labelTr: 'Sis' };
  if (code >= 51 && code <= 57) return { emoji: '🌦️', labelTr: 'Çisenti' };
  if (code >= 61 && code <= 67) return { emoji: '🌧️', labelTr: 'Yağmur' };
  if (code >= 71 && code <= 77) return { emoji: '🌨️', labelTr: 'Kar' };
  if (code >= 80 && code <= 82) return { emoji: '🌦️', labelTr: 'Sağanak' };
  if (code === 85 || code === 86) return { emoji: '🌨️', labelTr: 'Kar sağanağı' };
  if (code === 95) return { emoji: '⛈️', labelTr: 'Fırtına' };
  if (code === 96 || code === 99) return { emoji: '⛈️', labelTr: 'Şiddetli fırtına ⚠️' };
  return { emoji: '🌡️', labelTr: 'Bilinmiyor' };
}

// =========================================================
// Cache (in-process, 5-min TTL — digest aynı snapshot'ı 4 role için kullansın)
// =========================================================
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; snapshot: WeatherSnapshot }>();

function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

// =========================================================
// Public API
// =========================================================

export async function getDailyForecast(
  lat: number = DEFAULT_LAT,
  lon: number = DEFAULT_LON,
): Promise<WeatherSnapshot> {
  const key = cacheKey(lat, lon);
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return { ...cached.snapshot, fromCache: true };
  }

  const url = new URL(WEATHER_BASE);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,weather_code,wind_speed_10m_max,precipitation_sum');
  url.searchParams.set('forecast_days', '2');
  url.searchParams.set('timezone', DEFAULT_TZ);

  let today: DayForecast | null = null;
  let tomorrow: DayForecast | null = null;

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      console.warn(`[weather] open-meteo ${res.status}:`, await res.text());
      const empty: WeatherSnapshot = { today: null, tomorrow: null, fetchedAt: new Date().toISOString(), fromCache: false };
      cache.set(key, { at: now, snapshot: empty });
      return empty;
    }
    const data: any = await res.json();
    const daily = data?.daily;
    if (daily?.time && Array.isArray(daily.time) && daily.time.length >= 1) {
      today = buildDay(daily, 0);
      if (daily.time.length >= 2) tomorrow = buildDay(daily, 1);
    }
  } catch (e: any) {
    console.warn('[weather] fetch failed:', e?.message);
  }

  const snapshot: WeatherSnapshot = {
    today,
    tomorrow,
    fetchedAt: new Date().toISOString(),
    fromCache: false,
  };
  cache.set(key, { at: now, snapshot });
  return snapshot;
}

function buildDay(daily: any, idx: number): DayForecast {
  const code = Number(daily.weather_code?.[idx] ?? 0);
  const meta = weatherCodeMeta(code);
  return {
    dateIso: daily.time[idx],
    weatherCode: code,
    tempMax: Number(daily.temperature_2m_max?.[idx] ?? 0),
    tempMin: Number(daily.temperature_2m_min?.[idx] ?? 0),
    windMaxKmh: Number(daily.wind_speed_10m_max?.[idx] ?? 0),
    precipMm: Number(daily.precipitation_sum?.[idx] ?? 0),
    emoji: meta.emoji,
    labelTr: meta.labelTr,
  };
}

// =========================================================
// Format helpers for digest sections
// =========================================================

/** "⛅ Parçalı bulutlu · 24°C ↘ 18°C · Rüzgar 12 km/h" */
export function formatWeatherShort(day: DayForecast | null): string {
  if (!day) return '🌡️ Hava durumu alınamadı';
  return `${day.emoji} ${day.labelTr} · ${Math.round(day.tempMax)}°C ↘ ${Math.round(day.tempMin)}°C · Rüzgar ${Math.round(day.windMaxKmh)} km/h${day.precipMm > 1 ? ` · 💧 ${day.precipMm.toFixed(1)} mm` : ''}`;
}

/** HTML inline format — küçük bir info chip */
export function formatWeatherHtml(day: DayForecast | null, label = 'Bugün'): string {
  if (!day) return '';
  const warning = isWeatherWarning(day);
  const bg = warning ? '#fef3c7' : '#f0f9ff';
  const border = warning ? '#f59e0b' : '#bae6fd';
  return `<div style="background:${bg};border:1px solid ${border};border-radius:6px;padding:8px 12px;margin:8px 0;font-size:13px;color:#0a2540;">
<strong>${label}:</strong> ${day.emoji} ${day.labelTr} · ${Math.round(day.tempMax)}°/${Math.round(day.tempMin)}°C · 🌬 ${Math.round(day.windMaxKmh)} km/h${day.precipMm > 1 ? ` · 💧 ${day.precipMm.toFixed(1)} mm yağış` : ''}${warning ? ' <strong style="color:#92400e;">⚠ Dikkat</strong>' : ''}
</div>`;
}

/** Plain text format */
export function formatWeatherText(day: DayForecast | null, label = 'Bugun'): string {
  if (!day) return '';
  return `${label}: ${day.labelTr} ${Math.round(day.tempMax)}/${Math.round(day.tempMin)}C, ruzgar ${Math.round(day.windMaxKmh)} km/h${day.precipMm > 1 ? `, ${day.precipMm.toFixed(1)} mm yagis` : ''}${isWeatherWarning(day) ? ' [DIKKAT]' : ''}`;
}

/** Tekne operasyonu için risk: rüzgar > 25 km/h, fırtına/şiddetli yağış */
export function isWeatherWarning(day: DayForecast): boolean {
  if (day.windMaxKmh > 25) return true;
  if (day.precipMm > 10) return true;
  if (day.weatherCode >= 95) return true; // fırtına
  if (day.weatherCode >= 80 && day.weatherCode <= 82 && day.precipMm > 5) return true;
  return false;
}
