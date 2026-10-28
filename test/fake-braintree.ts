import { createHash, createHmac } from "node:crypto";

/** Plainly fake API keys: the fake API accepts these and nothing else. */
export const PUBLIC_KEY = "test-public-key";
export const PRIVATE_KEY = "test-private-key";

export const SANDBOX = "https://payments.sandbox.braintree-api.com/graphql";
export const PRODUCTION = "https://payments.braintree-api.com/graphql";

type Money = { value: string; currencyCode: string };
export type FakeTransaction = {
  id: string;
  legacyId: string;
  status: string;
  amount: Money;
  merchantAccountId: string;
  orderId: string | null;
  processorAuthorizationResponse: { legacyCode: string; message: string } | null;
  statusHistory: Record<string, unknown>[];
};
export type FakeRefund = { id: string; legacyId: string; status: string; amount: Money; refundedTransaction: { id: string } };
export type FakeMerchantAccount = { id: string; currencyCode: string; status: string };
export type Call = { url: string; operation: string; query: string; variables: any; headers: Record<string, string> };
type ErrorItem = { message: string; extensions: { errorClass: string; legacyCode?: string; inputPath?: string[] } };

const ZERO_DECIMAL = new Set(["JPY", "KRW", "CLP", "ISK"]);

/** Braintree's sandbox test nonces, and what they do here. */
const NONCES: Record<string, { status?: string; processorAuthorizationResponse?: FakeTransaction["processorAuthorizationResponse"]; statusHistory?: Record<string, unknown>[] }> = {
  "fake-valid-nonce": {},
  "fake-processor-declined-visa-nonce": { status: "PROCESSOR_DECLINED", processorAuthorizationResponse: { legacyCode: "2000", message: "Do Not Honor" } },
  "fake-gateway-rejected-fraud-nonce": {
    status: "GATEWAY_REJECTED",
    processorAuthorizationResponse: null,
    statusHistory: [{ __typename: "GatewayRejectedEvent", status: "GATEWAY_REJECTED", gatewayRejectionReason: "FRAUD" }],
  },
};

/** Braintree's GraphQL API, as far as the plugin uses it: answers 200 with `errors` as Braintree does. */
export const fakeBraintree = (options: { environment?: "sandbox" | "production" } = {}) => {
  const endpoint = options.environment === "production" ? PRODUCTION : SANDBOX;
  const calls: Call[] = [];
  const transactions = new Map<string, FakeTransaction>();
  const refunds = new Map<string, FakeRefund>();
  const state = {
    merchantAccounts: [
      { id: "shop_gbp", currencyCode: "GBP", status: "ACTIVE" },
      { id: "shop_eur", currencyCode: "EUR", status: "ACTIVE" },
      { id: "shop_jpy", currencyCode: "JPY", status: "ACTIVE" },
      { id: "shop_huf", currencyCode: "HUF", status: "ACTIVE" },
      { id: "shop_usd", currencyCode: "USD", status: "ACTIVE" },
    ] as FakeMerchantAccount[],
    /** Merchant accounts per page of `viewer.merchant.merchantAccounts`. */
    pageSize: 50,
    /** The answer the next request for an operation gets instead of its own. */
    next: new Map<string, () => Response>(),
  };
  let sequence = 0;

  /** Opaque to the plugin; shaped like Braintree's. */
  const globalId = (type: string, legacyId: string) => Buffer.from(`${type}_${legacyId}`).toString("base64").replace(/=+$/, "");
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const error = (message: string, errorClass = "VALIDATION", inputPath?: string[], legacyCode?: string): ErrorItem => ({
    message,
    extensions: { errorClass, ...(legacyCode ? { legacyCode } : {}), ...(inputPath ? { inputPath } : {}) },
  });
  const refuse = (operation: string, ...errors: ErrorItem[]) => json({ data: { [operation]: null }, errors, extensions: { requestId: `fake-request-${calls.length}` } });
  const notFound = (operation: string) => refuse(operation, error("An object with this ID was not found.", "NOT_FOUND", ["input", "transactionId"]));
  const refundedSoFar = (transactionId: string) => [...refunds.values()].filter((r) => r.refundedTransaction.id === transactionId).reduce((sum, r) => sum + Number(r.amount.value), 0);

  const createRefund = (transaction: FakeTransaction, amount: string): FakeRefund => {
    const legacyId = `fakerefund${++sequence}`;
    const refund = { id: globalId("refund", legacyId), legacyId, status: "SUBMITTED_FOR_SETTLEMENT", amount: { value: amount, currencyCode: transaction.amount.currencyCode }, refundedTransaction: { id: transaction.id } };
    refunds.set(refund.id, refund);
    return refund;
  };

  const answer = (operation: string, variables: any): Response => {
    switch (operation) {
      case "ping":
        return json({ data: { ping: "pong" } });

      case "createClientToken": {
        const merchantAccountId = variables?.input?.clientToken?.merchantAccountId;
        if (merchantAccountId && !state.merchantAccounts.some((a) => a.id === merchantAccountId)) {
          return refuse(operation, error("Merchant account ID is invalid.", "VALIDATION", ["input", "clientToken", "merchantAccountId"]));
        }
        return json({ data: { createClientToken: { clientToken: `fake-client-token-for-${merchantAccountId ?? "default"}` } } });
      }

      case "chargePaymentMethod":
      case "authorizePaymentMethod": {
        const { paymentMethodId, transaction: input } = variables.input;
        const account = state.merchantAccounts.find((a) => a.id === input.merchantAccountId);
        if (!account) return refuse(operation, error("Merchant account ID is invalid.", "VALIDATION", ["input", "transaction", "merchantAccountId"]));
        // "Must match the currency format of the merchant account."
        const format = ZERO_DECIMAL.has(account.currencyCode) ? /^\d+$/ : /^\d+\.\d{2}$/;
        if (!format.test(input.amount) || Number(input.amount) <= 0) return refuse(operation, error("Amount is an invalid format.", "VALIDATION", ["input", "transaction", "amount"]));
        const nonce = NONCES[paymentMethodId];
        // The example error of Braintree's own guide.
        if (!nonce) return refuse(operation, error("Unknown or expired single-use payment method.", "VALIDATION", ["input", "paymentMethodId"], "91565"));
        const legacyId = `fake${++sequence}`;
        const transaction: FakeTransaction = {
          id: globalId("transaction", legacyId),
          legacyId,
          status: nonce.status ?? (operation === "chargePaymentMethod" ? "SUBMITTED_FOR_SETTLEMENT" : "AUTHORIZED"),
          amount: { value: input.amount, currencyCode: account.currencyCode },
          merchantAccountId: account.id,
          orderId: input.orderId ?? null,
          processorAuthorizationResponse: nonce.processorAuthorizationResponse === undefined ? { legacyCode: "1000", message: "Approved" } : nonce.processorAuthorizationResponse,
          statusHistory: nonce.statusHistory ?? [],
        };
        transactions.set(transaction.id, transaction);
        return json({ data: { [operation]: { transaction } } });
      }

      case "captureTransaction": {
        const transaction = transactions.get(variables.input.transactionId);
        if (!transaction) return notFound(operation);
        if (transaction.status !== "AUTHORIZED") return refuse(operation, error("Cannot submit for settlement unless status is authorized.", "VALIDATION", ["input", "transactionId"]));
        const amount = variables.input.transaction?.amount ?? transaction.amount.value;
        if (Number(amount) > Number(transaction.amount.value)) return refuse(operation, error("Settlement amount is too large.", "VALIDATION", ["input", "transaction", "amount"]));
        Object.assign(transaction, { status: "SUBMITTED_FOR_SETTLEMENT", amount: { ...transaction.amount, value: amount } });
        return json({ data: { captureTransaction: { transaction } } });
      }

      case "refundTransaction": {
        const transaction = transactions.get(variables.input.transactionId);
        if (!transaction) return notFound(operation);
        if (transaction.status !== "SETTLED" && transaction.status !== "SETTLING") return refuse(operation, error("Cannot refund a transaction unless it is settled.", "VALIDATION", ["input", "transactionId"]));
        const amount = variables.input.refund?.amount ?? transaction.amount.value;
        if (refundedSoFar(transaction.id) + Number(amount) > Number(transaction.amount.value)) return refuse(operation, error("Refund amount is too large.", "VALIDATION", ["input", "refund", "amount"]));
        return json({ data: { refundTransaction: { refund: createRefund(transaction, amount) } } });
      }

      case "reverseTransaction": {
        const transaction = transactions.get(variables.input.transactionId);
        if (!transaction) return notFound(operation);
        if (transaction.status === "AUTHORIZED" || transaction.status === "SUBMITTED_FOR_SETTLEMENT") {
          transaction.status = "VOIDED";
          return json({ data: { reverseTransaction: { reversal: { __typename: "Transaction", ...transaction } } } });
        }
        if (transaction.status === "SETTLED" || transaction.status === "SETTLING") {
          const remaining = (Number(transaction.amount.value) - refundedSoFar(transaction.id)).toFixed(ZERO_DECIMAL.has(transaction.amount.currencyCode) ? 0 : 2);
          return json({ data: { reverseTransaction: { reversal: { __typename: "Refund", ...createRefund(transaction, remaining) } } } });
        }
        return refuse(operation, error("Transaction can only be voided if status is authorized, submitted_for_settlement, or - for PayPal - settlement_pending.", "VALIDATION", ["input", "transactionId"]));
      }

      case "node": {
        const transaction = transactions.get(variables.id);
        const refund = refunds.get(variables.id);
        if (transaction) return json({ data: { node: { __typename: "Transaction", ...transaction } } });
        if (refund) return json({ data: { node: { __typename: "Refund", ...refund } } });
        return json({ data: { node: null }, errors: [error("An object with this ID was not found.", "NOT_FOUND")] });
      }

      case "idsFromLegacyIds":
        // Braintree does not check that transactions exist.
        return json({ data: { idsFromLegacyIds: variables.input.ids.map((pair: { legacyId: string; type: string }) => globalId(pair.type.toLowerCase(), pair.legacyId)) } });

      case "viewer": {
        const start = variables?.after ? Number(variables.after) : 0;
        const page = state.merchantAccounts.slice(start, start + state.pageSize);
        const end = start + page.length;
        return json({
          data: {
            viewer: {
              merchant: {
                merchantAccounts: {
                  edges: page.map((node) => ({ node })),
                  pageInfo: { hasNextPage: end < state.merchantAccounts.length, endCursor: page.length ? String(end) : null },
                },
              },
            },
          },
        });
      }

      default:
        return json({ errors: [error(`Unknown field ${operation}`, "VALIDATION")] });
    }
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables?: any };
    // The root field of the operation: the first name inside its braces.
    const operation = /\{\s*(\w+)/.exec(query)?.[1] ?? "";
    calls.push({ url, operation, query, variables, headers });
    if (init?.method !== "POST" || url !== endpoint) return new Response("Not found", { status: 404 });
    if (headers.authorization !== `Basic ${Buffer.from(`${PUBLIC_KEY}:${PRIVATE_KEY}`).toString("base64")}`) {
      return json({ data: null, errors: [error("Authentication credentials are invalid.", "AUTHENTICATION")] });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(headers["braintree-version"] ?? "") || headers["content-type"] !== "application/json") {
      return json({ data: null, errors: [error("Requests need a Braintree-Version header and a JSON body.", "VALIDATION")] });
    }
    const next = state.next.get(operation);
    if (next) {
      state.next.delete(operation);
      return next();
    }
    return answer(operation, variables);
  };

  return {
    fetch,
    calls,
    state,
    transactions,
    refunds,
    globalId,
    callsOf: (operation: string) => calls.filter((c) => c.operation === operation),
    transaction: (id: string) => transactions.get(id)!,
    /** The nightly settlement batch, as `sandboxSettleTransaction` would. */
    settle: (id: string) => Object.assign(transactions.get(id)!, { status: "SETTLED" }),
    /** The next request for `operation` gets this answer. */
    answerNext: (operation: string, response: () => Response) => state.next.set(operation, response),
    reset: () => (calls.length = 0),
  };
};

export type FakeBraintree = ReturnType<typeof fakeBraintree>;

// ---------------------------------------------------------------- webhooks

/** Base64 in lines of 60 characters with a final newline, as Braintree's gateway writes payloads. */
export const encodePayload = (xml: string) => `${Buffer.from(xml).toString("base64").replace(/.{60}/g, "$&\n")}\n`.replace(/\n\n$/, "\n");

export const sign = (payload: string, keys: { publicKey?: string; privateKey?: string } = {}) =>
  `${keys.publicKey ?? PUBLIC_KEY}|${createHmac("sha1", createHash("sha1").update(keys.privateKey ?? PRIVATE_KEY).digest()).update(payload).digest("hex")}`;

/** A notification as Braintree posts it: form-encoded `bt_signature` and `bt_payload`. */
export const webhookRequest = (xml: string, options: { publicKey?: string; privateKey?: string; signature?: string; payload?: string; url?: string } = {}) => {
  const payload = options.payload ?? encodePayload(xml);
  const signature = options.signature ?? sign(payload, options);
  return new Request(options.url ?? "http://ecom.test/payments/webhooks/braintree", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ bt_signature: signature, bt_payload: payload }).toString(),
  });
};

export const notificationXml = (kind: string, subject: string, timestamp = "2026-10-28T12:00:00Z") => `<?xml version="1.0" encoding="UTF-8"?>
<notification>
  <timestamp type="datetime">${timestamp}</timestamp>
  <kind>${kind}</kind>
  <subject>${subject}</subject>
</notification>
`;

/** A dispute's notification, shaped like Braintree's sample notifications. */
export const disputeXml = (
  kind: string,
  dispute: { id?: string; status?: string; transactionId: string; amount?: string; currency?: string; reason?: string; orderId?: string },
  timestamp?: string,
) =>
  notificationXml(
    kind,
    `
    <dispute>
      <amount>${dispute.amount ?? "25.00"}</amount>
      <amount-disputed>${dispute.amount ?? "25.00"}</amount-disputed>
      <amount-won>0.00</amount-won>
      <currency-iso-code>${dispute.currency ?? "GBP"}</currency-iso-code>
      <received-date type="date">2026-10-27</received-date>
      <reply-by-date type="date">2026-11-16</reply-by-date>
      <kind>chargeback</kind>
      <status>${dispute.status ?? "open"}</status>
      <reason>${dispute.reason ?? "fraud"}</reason>
      <reason-description nil="true"/>
      <id>${dispute.id ?? "fakedispute1"}</id>
      <transaction>
        <id>${dispute.transactionId}</id>
        <amount>${dispute.amount ?? "25.00"}</amount>
        <order-id>${dispute.orderId ?? "UK-000042"}</order-id>
        <purchase-order-number nil="true"/>
      </transaction>
      <date-opened type="date">2026-10-28</date-opened>
    </dispute>
  `,
    timestamp,
  );
