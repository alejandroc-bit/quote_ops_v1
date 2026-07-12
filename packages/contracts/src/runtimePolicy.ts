export type ImmutableQuoteFields = {
  base_rate_mxn: number;
  recommended_rate_mxn: number;
  cost_mxn?: number;
  margin_mxn?: number;
  margin_pct?: number;
};

const immutableQuoteFields: Array<keyof ImmutableQuoteFields> = [
  "base_rate_mxn",
  "recommended_rate_mxn",
  "cost_mxn",
  "margin_mxn",
  "margin_pct"
];

export function assertQuoteCoreFieldsPreserved<T extends ImmutableQuoteFields>(
  before: T,
  after: Partial<ImmutableQuoteFields>
): T {
  for (const field of ["base_rate_mxn", "recommended_rate_mxn"] as const) {
    if (after[field] !== before[field]) {
      throw new Error(`immutable quote field changed: ${field}`);
    }
  }

  for (const field of immutableQuoteFields) {
    if (after[field] !== undefined && after[field] !== before[field]) {
      throw new Error(`immutable quote field changed: ${field}`);
    }
  }
  return before;
}
