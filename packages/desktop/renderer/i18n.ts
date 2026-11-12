import { messages } from './messages';

type Key = keyof typeof messages;
let locale = 'en';
let translations: Partial<Record<Key, string>> = {};
export function configureLocale(language: string, catalog: Partial<Record<Key, string>> = {}) {
  locale = Intl.getCanonicalLocales(language)[0] ?? 'en';
  translations = catalog;
  document.documentElement.lang = locale;
  document.documentElement.dir = /^(ar|fa|he|ur)(-|$)/.test(locale) ? 'rtl' : 'ltr';
}
export function t(key: Key, values: unknown[] = []): string {
  const message = translations[key] ?? messages[key];
  return message.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)] ?? ''));
}
export function dockLabel(key: string) {
  return key in messages ? t(key as Key) : key;
}
export function formatMoney(value: number) {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 4 }).format(value);
}
