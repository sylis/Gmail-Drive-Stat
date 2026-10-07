const UNITS = ['octets', 'Ko', 'Mo', 'Go', 'To'];

/** Taille lisible en unités binaires, comme l'affiche Google (15 Go = 15 × 1024³ octets). */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toLocaleString('fr-FR', { maximumFractionDigits: digits })} ${UNITS[unit]}`;
}

export function formatPercent(part: number, total: number): string {
  if (total <= 0) return '–';
  return `${((part / total) * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;
}
