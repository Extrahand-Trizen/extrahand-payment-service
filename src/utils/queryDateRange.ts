const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Inclusive start of calendar day (UTC) for `YYYY-MM-DD` query params. */
export function parseQueryStartDate(value: string): Date {
  if (DATE_ONLY.test(value)) {
    return new Date(`${value}T00:00:00.000Z`);
  }
  return new Date(value);
}

/** Inclusive end of calendar day (UTC) for `YYYY-MM-DD` query params. */
export function parseQueryEndDateInclusive(value: string): Date {
  if (DATE_ONLY.test(value)) {
    return new Date(`${value}T23:59:59.999Z`);
  }
  return new Date(value);
}
