const tidy = value => String(value ?? '').normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/g, '');

export const normalize = value => value.replace(/[\s（）()]/g, '').toLowerCase();
export const normalizeCompanyName = value => normalize(tidy(value));
export const normalizeCreditCode = value => tidy(value).replace(/\s/g, '').toUpperCase();

export function similarCustomer(a, b) {
  const stem = value => Array.from(normalize(value).replace(/有限责任公司|股份有限公司|有限公司/g, ''));
  const x = stem(a), y = stem(b);
  const longest = Math.max(x.length, y.length);
  if (Math.min(x.length, y.length) < 4 || 1 - Math.abs(x.length - y.length) / longest < 0.82) return false;

  let row = Array.from({length: y.length + 1}, (_, i) => i);
  for (let i = 0; i < x.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < y.length; j++) {
      next[j + 1] = Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (x[i] === y[j] ? 0 : 1));
    }
    row = next;
  }
  return 1 - row[y.length] / longest >= 0.82;
}
