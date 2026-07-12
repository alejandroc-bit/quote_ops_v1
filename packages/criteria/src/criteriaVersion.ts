export function createCriteriaVersion(prefix: string, date: Date, sequence: number): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${prefix}-${year}.${month}.${day}.${sequence}`;
}

