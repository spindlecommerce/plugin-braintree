import type { BraintreeContext } from "./settings.ts";

/**
 * Braintree's GraphQL API over the platform's fetch, with no SDK. Every query and mutation is a
 * POST to one endpoint per environment, with Basic auth from the API keys.
 */
export const ENDPOINTS = {
  sandbox: "https://payments.sandbox.braintree-api.com/graphql",
  production: "https://payments.braintree-api.com/graphql",
} as const;

/**
 * Every request names a version, as a date. Braintree asks for the date an integration was written;
 * the queries here were checked against its schema of October 2026.
 */
export const BRAINTREE_VERSION = "2026-10-28";

/**
 * Generous: a charge that times out may still have gone through, which is worse than a slow
 * checkout. Braintree's own SDKs wait 60 seconds.
 */
const TIMEOUT_MS = 30_000;

/** One of the `errors` of an answer. `errorClass` is VALIDATION, AUTHENTICATION, NOT_FOUND, … */
export type BraintreeErrorItem = {
  message?: string;
  path?: (string | number)[];
  extensions?: { errorClass?: string; legacyCode?: string; inputPath?: (string | number)[] };
};

export class BraintreeError extends Error {
  /** The HTTP status: Braintree answers 200 for most errors, with `errors` in the body. */
  readonly status: number;
  readonly errors: BraintreeErrorItem[];
  constructor(status: number, message: string, errors: BraintreeErrorItem[] = []) {
    super(message);
    this.name = "BraintreeError";
    this.status = status;
    this.errors = errors;
  }
  get errorClass(): string | null {
    return this.errors.find((e) => e.extensions?.errorClass)?.extensions?.errorClass ?? null;
  }
}

export const describeErrors = (errors: BraintreeErrorItem[]) => [...new Set(errors.map((e) => e.message).filter(Boolean))].join("; ");

/** A refusal of what was asked (VALIDATION) or of something that does not exist (NOT_FOUND), rather than an outage or bad keys. */
export const isRefusal = (error: unknown): error is BraintreeError => error instanceof BraintreeError && (error.errorClass === "VALIDATION" || error.errorClass === "NOT_FOUND");

export type GraphQLAnswer<T> = { data: T | null; errors: BraintreeErrorItem[] };

/**
 * Runs a query or mutation and returns its data and errors as they came: Braintree answers 200
 * with `errors` (and `null` where a field failed) rather than with an HTTP error, and a declined
 * payment is a transaction with a failure status, not an error. Throws on anything that is not a
 * GraphQL answer (an outage page, a timeout).
 */
export const braintreeRequest = async <T>(ctx: BraintreeContext, query: string, variables?: Record<string, unknown>): Promise<GraphQLAnswer<T>> => {
  const { environment, publicKey, privateKey } = ctx.settings;
  const response = await ctx.fetch(ENDPOINTS[environment === "production" ? "production" : "sandbox"], {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${publicKey.trim()}:${privateKey.trim()}`).toString("base64")}`,
      "braintree-version": BRAINTREE_VERSION,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(variables ? { query, variables } : { query }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: an outage page or a proxy's answer.
  }
  const answer = body && typeof body === "object" ? (body as { data?: T | null; errors?: unknown }) : null;
  const errors = Array.isArray(answer?.errors) ? (answer.errors as BraintreeErrorItem[]) : [];
  if (!response.ok || !answer) {
    throw new BraintreeError(response.status, `Braintree answered ${response.status}: ${describeErrors(errors) || text.slice(0, 200) || response.statusText}`, errors);
  }
  return { data: answer.data ?? null, errors };
};

/** The data of a query or mutation, or its errors as a BraintreeError. */
export const braintreeQuery = async <T>(ctx: BraintreeContext, query: string, variables?: Record<string, unknown>): Promise<T> => {
  const { data, errors } = await braintreeRequest<T>(ctx, query, variables);
  if (errors.length > 0 || !data) throw new BraintreeError(200, `Braintree: ${describeErrors(errors) || "no data in the answer"}`, errors);
  return data;
};

// ---------------------------------------------------------------- amounts

/**
 * Minor units per currency, as the platform stores amounts (Ecom's src/lib/money.ts): ISO 4217's
 * exponents, 2 for any currency not listed. Intl's currency digits differ for some (HUF, IDR, COP
 * and IQD, say), so they would be wrong here. Braintree's own list agrees: HUF has decimals.
 */
const EXPONENTS: Record<string, number> = {
  BHD: 3, BIF: 0, CLP: 0, DJF: 0, GNF: 0, IQD: 3, ISK: 0, JOD: 3, JPY: 0, KMF: 0, KRW: 0,
  KWD: 3, LYD: 3, OMR: 3, PYG: 0, RWF: 0, TND: 3, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
};
const exponent = (currency: string) => EXPONENTS[currency.toUpperCase()] ?? 2;

/** Minor units → Braintree's decimal string: 1999 USD → "19.99", 1500 JPY → "1500", 150000 HUF → "1500.00". */
export const toAmount = (minor: number, currency: string): string => {
  const digits = exponent(currency);
  const sign = minor < 0 ? "-" : "";
  const padded = String(Math.abs(Math.round(minor))).padStart(digits + 1, "0");
  return digits === 0 ? `${sign}${padded}` : `${sign}${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
};

/** Braintree's decimal string → minor units: "19.99" USD → 1999, "250.0" → 25000, "1500" JPY → 1500. Null when it is not an amount. */
export const toMinorUnits = (amount: string | null | undefined, currency: string): number | null => {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(amount?.trim() ?? "");
  if (!match) return null;
  const digits = exponent(currency);
  const fraction = (match[2] ?? "").padEnd(digits + 1, "0");
  const minor = Number(match[1]) * 10 ** digits + Number(fraction.slice(0, digits) || "0");
  // More decimals than the currency has: rounded half up.
  return Number(fraction[digits]) >= 5 ? minor + 1 : minor;
};
