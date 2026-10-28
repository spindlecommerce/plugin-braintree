import {
  InvalidStateError,
  PaymentDeclinedError,
  ValidationError,
  type AuthorizeInput,
  type AuthorizeResult,
  type PaymentProviderDefinition,
  type PaymentWebhookEvent,
  type PluginContext,
  type ProviderResult,
} from "@spindlecommerce/plugin-sdk";
import { BraintreeError, braintreeQuery, braintreeRequest, describeErrors, isRefusal, toAmount, toMinorUnits } from "./api.ts";
import { parseMerchantAccounts, type BraintreeContext, type BraintreeSettings } from "./settings.ts";
import { child, childText, readNotification, verifyBraintreeSignature, type BraintreeNotification } from "./webhook.ts";

type Context = PluginContext<BraintreeSettings>;

// ---------------------------------------------------------------- Braintree's GraphQL documents

const TRANSACTION_FIELDS = `
  id
  legacyId
  status
  amount { value currencyCode }
  merchantAccountId
  orderId
  processorAuthorizationResponse { legacyCode message }
  statusHistory { ... on GatewayRejectedEvent { gatewayRejectionReason } }
`;

export const CREATE_CLIENT_TOKEN = `mutation CreateClientToken($input: CreateClientTokenInput) {
  createClientToken(input: $input) { clientToken }
}`;
export const CHARGE = `mutation ChargePaymentMethod($input: ChargePaymentMethodInput!) {
  chargePaymentMethod(input: $input) { transaction { ${TRANSACTION_FIELDS} } }
}`;
export const AUTHORIZE = `mutation AuthorizePaymentMethod($input: AuthorizePaymentMethodInput!) {
  authorizePaymentMethod(input: $input) { transaction { ${TRANSACTION_FIELDS} } }
}`;
export const CAPTURE = `mutation CaptureTransaction($input: CaptureTransactionInput!) {
  captureTransaction(input: $input) { transaction { id legacyId status amount { value currencyCode } } }
}`;
export const REFUND = `mutation RefundTransaction($input: RefundTransactionInput!) {
  refundTransaction(input: $input) { refund { id legacyId status amount { value currencyCode } } }
}`;
export const REVERSE = `mutation ReverseTransaction($input: ReverseTransactionInput!) {
  reverseTransaction(input: $input) {
    reversal {
      __typename
      ... on Transaction { id legacyId status }
      ... on Refund { id legacyId status }
    }
  }
}`;
export const TRANSACTION = `query Transaction($id: ID!) {
  node(id: $id) { __typename ... on Transaction { ${TRANSACTION_FIELDS} } }
}`;
export const TRANSACTION_IDS = `query TransactionIds($input: IdsFromLegacyIdsInput!) {
  idsFromLegacyIds(input: $input)
}`;
export const PING = `query Ping { ping }`;
export const MERCHANT_ACCOUNTS = `query MerchantAccounts($after: String) {
  viewer {
    merchant {
      merchantAccounts(first: 50, after: $after) {
        edges { node { id currencyCode status } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

type Money = { value?: string | null; currencyCode?: string | null } | null;

export type BraintreeTransaction = {
  id: string;
  legacyId?: string | null;
  status: string;
  amount?: Money;
  merchantAccountId?: string | null;
  orderId?: string | null;
  processorAuthorizationResponse?: { legacyCode?: string | null; message?: string | null } | null;
  statusHistory?: ({ gatewayRejectionReason?: string | null } | null)[] | null;
};
type Reversal = { __typename: string; id: string; legacyId?: string | null; status: string };
export type MerchantAccount = { id: string; currencyCode: string | null; status: string | null };

// ---------------------------------------------------------------- statuses

/** Money on its way to the merchant: submitted for settlement, settling, settled (or partly). */
const CAPTURED = new Set(["SUBMITTED_FOR_SETTLEMENT", "SETTLING", "SETTLED", "SETTLEMENT_PENDING", "SETTLEMENT_CONFIRMED"]);
/** Nothing is held: what `void` finds after Braintree voided or expired an authorization itself. */
const RELEASED = new Set(["VOIDED", "AUTHORIZATION_EXPIRED", "PROCESSOR_DECLINED", "GATEWAY_REJECTED", "FAILED"]);
/** Refunds that did not go through. */
const UNSUCCESSFUL = new Set([...RELEASED, "SETTLEMENT_DECLINED"]);

const DECLINES: Record<string, string> = {
  PROCESSOR_DECLINED: "The bank declined the payment",
  GATEWAY_REJECTED: "Braintree rejected the payment",
  FAILED: "The payment could not be sent to the bank",
  SETTLEMENT_DECLINED: "The bank declined to settle the payment",
  VOIDED: "The payment was voided",
  AUTHORIZATION_EXPIRED: "The payment's authorization expired",
};

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const humanize = (value: string) => value.toLowerCase().replaceAll("_", " ");

/**
 * The processor's response text ("Insufficient Funds") for a decline or failure; why the gateway
 * rejected it (its processor may have said "Approved" before an AVS or CVV rejection); else what
 * the status means.
 */
const declineMessage = (transaction: BraintreeTransaction) => {
  const { status } = transaction;
  const response = status === "PROCESSOR_DECLINED" || status === "FAILED" ? text(transaction.processorAuthorizationResponse?.message) : null;
  if (response) return response;
  const rejection = status === "GATEWAY_REJECTED" ? transaction.statusHistory?.map((event) => text(event?.gatewayRejectionReason)).find(Boolean) : null;
  const message = DECLINES[status] ?? `The payment is not complete (${humanize(status)})`;
  return rejection ? `${message} (${humanize(rejection)})` : message;
};

/** What authorize answers for a transaction, or the decline it is. */
const outcome = (transaction: BraintreeTransaction): AuthorizeResult => {
  const raw = { status: transaction.status, legacyId: transaction.legacyId ?? null, merchantAccountId: transaction.merchantAccountId ?? null };
  if (transaction.status === "AUTHORIZED") return { status: "authorized", pspReference: transaction.id, raw };
  if (CAPTURED.has(transaction.status)) return { status: "captured", pspReference: transaction.id, raw };
  // Some payment methods authorize in the background: the order waits, and staff capture it once Braintree shows it authorized.
  if (transaction.status === "AUTHORIZING") return { status: "pending", pspReference: transaction.id, raw };
  throw new PaymentDeclinedError(transaction.status.toLowerCase(), declineMessage(transaction));
};

// ---------------------------------------------------------------- helpers

const merchantAccountFor = (ctx: BraintreeContext, currency: string) => parseMerchantAccounts(ctx.settings.merchantAccounts).get(currency.toUpperCase()) ?? null;

/** The transaction an order's payment refers to. */
const transactionOf = (pspReference: string | null) => {
  if (!pspReference) throw new InvalidStateError("This order has no Braintree transaction");
  return pspReference;
};

/** Braintree's refusal of what staff asked (capturing more than was authorized, refunding before settlement), told to them. */
const staffFacing = (error: unknown) => (isRefusal(error) ? new InvalidStateError(error.message) : error);

/** A transaction by its GraphQL id; null when Braintree has none by that id. */
export const findTransaction = async (ctx: BraintreeContext, id: string): Promise<BraintreeTransaction | null> => {
  try {
    const { node } = await braintreeQuery<{ node: (BraintreeTransaction & { __typename?: string }) | null }>(ctx, TRANSACTION, { id });
    return node?.__typename === "Transaction" ? node : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw error;
  }
};

/** Voids a transaction that has not settled, refunds a settled one in full. */
const reverse = async (ctx: BraintreeContext, id: string): Promise<ProviderResult> => {
  const { reverseTransaction } = await braintreeQuery<{ reverseTransaction: { reversal: Reversal | null } | null }>(ctx, REVERSE, { input: { transactionId: id } });
  const reversal = reverseTransaction?.reversal;
  if (!reversal) throw new Error("Braintree answered the reversal without its result");
  return { pspReference: reversal.id, raw: { reversal: reversal.__typename === "Refund" ? "refund" : "void", status: reversal.status, legacyId: reversal.legacyId ?? null } };
};

/**
 * A merchant account mapped to the wrong currency would charge the order's amount in its own
 * currency (¥1500 as $1500). Such a transaction is reversed at once and the order declined.
 */
const guardCurrency = async (ctx: Context, transaction: BraintreeTransaction, currency: string) => {
  const charged = text(transaction.amount?.currencyCode)?.toUpperCase();
  if (!charged || charged === currency.toUpperCase()) return;
  if (transaction.status === "AUTHORIZED" || CAPTURED.has(transaction.status)) {
    await reverse(ctx, transaction.id).catch((error: unknown) =>
      ctx.logger.error({ err: error, transaction: transaction.legacyId ?? transaction.id }, "Could not reverse a Braintree transaction made in the wrong currency: reverse it in the Control Panel"),
    );
  }
  throw new PaymentDeclinedError("currency_mismatch", `Braintree merchant account ${transaction.merchantAccountId ?? "?"} takes ${charged}, not ${currency}: the plugin's merchant accounts setting maps ${currency} to it`);
};

/** The safety net's payment: a transaction the platform was told of, which must match the order. */
const confirm = async (ctx: BraintreeContext, reference: string, input: AuthorizeInput): Promise<AuthorizeResult> => {
  const transaction = await findTransaction(ctx, reference);
  if (!transaction) throw new PaymentDeclinedError("payment_incomplete", "The Braintree transaction was not found");
  const currency = text(transaction.amount?.currencyCode)?.toUpperCase();
  if (currency !== input.currency.toUpperCase() || toMinorUnits(transaction.amount?.value, input.currency) !== input.amount) {
    throw new PaymentDeclinedError("amount_mismatch", "The payment does not match the order total; pay again");
  }
  return outcome(transaction);
};

/** Notifications carry the legacy ids the Control Panel shows; authorize recorded the GraphQL API's own. */
const transactionId = async (ctx: BraintreeContext, legacyId: string) => {
  const { idsFromLegacyIds } = await braintreeQuery<{ idsFromLegacyIds: (string | null)[] | null }>(ctx, TRANSACTION_IDS, { input: { ids: [{ legacyId, type: "TRANSACTION" }] } });
  const id = idsFromLegacyIds?.[0];
  if (!id) throw new Error(`Braintree gave no GraphQL id for transaction ${legacyId}`);
  return id;
};

// ---------------------------------------------------------------- webhooks

/** How a dispute ended. Auto-accepted and expired disputes are ones the merchant did not answer in time: lost. */
const DISPUTE_OUTCOMES = new Map([
  ["dispute_won", "won"],
  ["dispute_lost", "lost"],
  ["dispute_accepted", "accepted"],
  ["dispute_auto_accepted", "accepted"],
  ["dispute_expired", "expired"],
]);

/** Disputes and declined settlements, as payment events. Every other kind (`check`, the test notification, included) is acknowledged with none. */
export const toPaymentEvents = async (ctx: BraintreeContext, notification: BraintreeNotification): Promise<PaymentWebhookEvent[]> => {
  const { kind, timestamp, subject } = notification;
  if (!kind) return [];
  if (kind === "dispute_opened" || DISPUTE_OUTCOMES.has(kind)) {
    const dispute = child(subject, "dispute");
    const legacyId = childText(child(dispute, "transaction"), "id");
    if (!dispute || !legacyId) return [];
    const currency = childText(dispute, "currency-iso-code")?.toUpperCase();
    const amount = currency ? toMinorUnits(childText(dispute, "amount-disputed") ?? childText(dispute, "amount"), currency) : null;
    const opened = kind === "dispute_opened";
    const disputeId = childText(dispute, "id");
    return [
      {
        // Stable across redeliveries of the same notification.
        id: `${kind}:${disputeId ?? legacyId}:${timestamp ?? ""}`,
        type: opened ? "dispute_opened" : "dispute_closed",
        pspReference: await transactionId(ctx, legacyId),
        ...(amount !== null ? { amount } : {}),
        ...(currency ? { currency } : {}),
        reason: (opened ? childText(dispute, "reason") : DISPUTE_OUTCOMES.get(kind)) ?? undefined,
        raw: { kind, dispute: disputeId, disputeKind: childText(dispute, "kind"), status: childText(dispute, "status"), transaction: legacyId },
      },
    ];
  }
  if (kind === "transaction_settlement_declined") {
    const transaction = child(subject, "transaction");
    const legacyId = childText(transaction, "id");
    if (!legacyId) return [];
    const currency = childText(transaction, "currency-iso-code")?.toUpperCase();
    const amount = currency ? toMinorUnits(childText(transaction, "amount"), currency) : null;
    return [
      {
        id: `${kind}:${legacyId}:${timestamp ?? ""}`,
        type: "failed",
        pspReference: await transactionId(ctx, legacyId),
        ...(amount !== null ? { amount } : {}),
        ...(currency ? { currency } : {}),
        reason: childText(transaction, "processor-settlement-response-text") ?? DECLINES.SETTLEMENT_DECLINED,
        raw: { kind, status: childText(transaction, "status"), transaction: legacyId },
      },
    ];
  }
  return [];
};

// ---------------------------------------------------------------- the provider

/**
 * Braintree transactions from a payment method nonce: the storefront tokenizes the card or PayPal
 * account with Braintree's client SDK or Drop-in, using the session's client token, and sends the
 * nonce with the order. See README.md.
 */
export const braintreeProvider: PaymentProviderDefinition<BraintreeSettings> = {
  code: "braintree",
  title: "Braintree",
  description: "Cards and PayPal through Braintree, paid with a nonce from Braintree's client SDK or Drop-in.",

  /** A merchant account settles in one currency: offered only in the currencies mapped to one. */
  isAvailable: (input, ctx) => merchantAccountFor(ctx, input.currency) !== null,

  /** A client token for the currency's merchant account, for the storefront's Drop-in. Nothing is charged until authorize. */
  createSession: async (input, ctx) => {
    const merchantAccountId = merchantAccountFor(ctx, input.currency);
    if (!merchantAccountId) throw new InvalidStateError(`Braintree does not take payments in ${input.currency} here`);
    // Nothing to pay (a fully discounted cart): the storefront places the order directly.
    if (input.amount <= 0) return { data: { merchantAccountId }, clientData: { clientToken: null } };
    let clientToken: string | null;
    try {
      const { createClientToken } = await braintreeQuery<{ createClientToken: { clientToken: string | null } | null }>(ctx, CREATE_CLIENT_TOKEN, { input: { clientToken: { merchantAccountId } } });
      clientToken = text(createClientToken?.clientToken);
    } catch (error) {
      // A merchant account Braintree does not know, say: this cart cannot be paid as things are.
      if (isRefusal(error)) throw new InvalidStateError(`Braintree cannot take this payment: ${error.message.replace(/^Braintree: /, "")}`);
      throw error;
    }
    if (!clientToken) throw new Error("Braintree answered without a client token");
    return { data: { merchantAccountId }, clientData: { clientToken } };
  },

  /**
   * Charges (capture at checkout) or authorizes the nonce the storefront sent, for the order's
   * total, labelled with the order number. Without a nonce, `paymentData.pspReference` names a
   * transaction made already (the platform placing an order from a webhook), which is looked up
   * instead.
   */
  authorize: async (input, ctx) => {
    if (input.amount <= 0) return { status: "captured", pspReference: null };
    // `paymentData.nonce`; or `token`, the one field of the storefront API's PaymentDataInput.
    const nonce = text(input.paymentData.nonce) ?? text(input.paymentData.token);
    if (!nonce) {
      const reference = text(input.paymentData.pspReference);
      // A decline, not a validation error: only a decline cancels the order and reopens the cart.
      if (!reference) throw new PaymentDeclinedError("payment_incomplete", "No Braintree payment method nonce was sent with the order");
      return confirm(ctx, reference, input);
    }
    const merchantAccountId = merchantAccountFor(ctx, input.currency);
    if (!merchantAccountId) throw new PaymentDeclinedError("currency_not_supported", `Braintree does not take payments in ${input.currency} here`);
    const field = input.captureImmediately ? "chargePaymentMethod" : "authorizePaymentMethod";
    const { data, errors } = await braintreeRequest<Record<string, { transaction: BraintreeTransaction | null } | null>>(ctx, input.captureImmediately ? CHARGE : AUTHORIZE, {
      input: { paymentMethodId: nonce, transaction: { amount: toAmount(input.amount, input.currency), merchantAccountId, orderId: input.orderNumber } },
    });
    const transaction = data?.[field]?.transaction;
    if (!transaction) {
      // No transaction came of it (a used or unknown nonce, an amount the account refuses, …): nothing was charged.
      const refused = new BraintreeError(200, describeErrors(errors) || "Braintree did not take the payment", errors);
      if (refused.errorClass !== "VALIDATION") ctx.logger.error({ errors }, "Braintree refused to create a transaction");
      throw new PaymentDeclinedError("payment_refused", refused.message);
    }
    await guardCurrency(ctx, transaction, input.currency);
    return outcome(transaction);
  },

  /** Submits the authorization for settlement, for the amount staff capture (less than authorized is a partial capture). */
  capture: async (input, ctx) => {
    const id = transactionOf(input.pspReference);
    try {
      const { captureTransaction } = await braintreeQuery<{ captureTransaction: { transaction: BraintreeTransaction | null } | null }>(ctx, CAPTURE, {
        input: { transactionId: id, transaction: { amount: toAmount(input.amount, input.currency) } },
      });
      const transaction = captureTransaction?.transaction;
      if (!transaction) throw new Error("Braintree answered the capture without its transaction");
      return { pspReference: transaction.id, raw: { status: transaction.status, legacyId: transaction.legacyId ?? null, amount: transaction.amount?.value ?? null } };
    } catch (error) {
      throw staffFacing(error);
    }
  },

  /** Refunds a settled transaction, in full or in part. The refund's own id is its reference. */
  refund: async (input, ctx) => {
    const id = transactionOf(input.pspReference);
    try {
      const { refundTransaction } = await braintreeQuery<{ refundTransaction: { refund: { id: string; legacyId?: string | null; status: string } | null } | null }>(ctx, REFUND, {
        input: { transactionId: id, refund: { amount: toAmount(input.amount, input.currency) } },
      });
      const refund = refundTransaction?.refund;
      if (!refund) throw new Error("Braintree answered the refund without its result");
      if (UNSUCCESSFUL.has(refund.status)) throw new InvalidStateError(`Braintree: the refund was ${humanize(refund.status)}`);
      return { pspReference: refund.id, raw: { status: refund.status, legacyId: refund.legacyId ?? null, transaction: id } };
    } catch (error) {
      throw staffFacing(error);
    }
  },

  /**
   * Reverses an order's transaction: voids it before settlement, refunds it after. Without a
   * transaction (a checkout that placed no order has only its session, a client token) nothing was
   * secured, so there is nothing to release.
   */
  void: async (input, ctx) => {
    if (!input.pspReference) return { pspReference: null };
    try {
      return await reverse(ctx, input.pspReference);
    } catch (error) {
      if (isRefusal(error)) {
        // Nothing left to release: voided already (in the Control Panel, say), or the authorization expired.
        const transaction = await findTransaction(ctx, input.pspReference);
        if (transaction && RELEASED.has(transaction.status)) return { pspReference: transaction.id, raw: { status: transaction.status, released: false } };
      }
      throw staffFacing(error);
    }
  },

  /** Disputes and declined settlements. The signature is checked with the API keys: there is no separate webhook secret. */
  webhook: async (request, ctx) => {
    const form = new URLSearchParams(await request.text());
    const signature = form.get("bt_signature") ?? "";
    const payload = form.get("bt_payload") ?? "";
    const keys = { publicKey: ctx.settings.publicKey.trim(), privateKey: ctx.settings.privateKey.trim() };
    if (!verifyBraintreeSignature(keys, signature, payload)) throw new ValidationError("Invalid Braintree webhook signature");
    return { events: await toPaymentEvents(ctx, readNotification(payload)) };
  },
};

// ---------------------------------------------------------------- Test connection

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Every merchant account of the Braintree account, a page at a time. */
export const listMerchantAccounts = async (ctx: BraintreeContext): Promise<MerchantAccount[]> => {
  type Connection = { edges?: ({ node?: MerchantAccount | null } | null)[] | null; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null };
  const accounts: MerchantAccount[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const answer: { viewer: { merchant: { merchantAccounts: Connection | null } | null } | null } = await braintreeQuery(ctx, MERCHANT_ACCOUNTS, { after });
    const connection = answer.viewer?.merchant?.merchantAccounts;
    if (!connection) throw new Error("Braintree listed no merchant accounts");
    for (const edge of connection.edges ?? []) if (edge?.node) accounts.push(edge.node);
    if (!connection.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) break;
    after = connection.pageInfo.endCursor;
  }
  return accounts;
};

/** "Test connection": the keys work in the environment, and each merchant account exists in its currency. */
export const checkConnection = async (ctx: BraintreeContext): Promise<{ ok: boolean; message: string }> => {
  const where = ctx.settings.environment === "production" ? "production" : "the sandbox";
  let configured: Map<string, string>;
  try {
    configured = parseMerchantAccounts(ctx.settings.merchantAccounts);
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
  try {
    await braintreeQuery<{ ping: string }>(ctx, PING);
  } catch (error) {
    if (error instanceof BraintreeError && (error.errorClass === "AUTHENTICATION" || error.status === 401)) {
      return { ok: false, message: `Braintree refused the API keys in ${where}: check both keys, and that they are ${where === "production" ? "production" : "sandbox"} keys.` };
    }
    return { ok: false, message: `Could not reach Braintree: ${errorMessage(error)}` };
  }
  const listed = [...configured].map(([currency, id]) => `${id} (${currency})`).join(", ");
  let accounts: MerchantAccount[];
  try {
    accounts = await listMerchantAccounts(ctx);
  } catch (error) {
    return { ok: true, message: `Connected to Braintree in ${where}. Merchant accounts: ${listed}. Braintree did not list its merchant accounts, so they were not checked (${errorMessage(error)}).` };
  }
  const problems = [...configured].flatMap(([currency, id]) => {
    const account = accounts.find((a) => a.id === id);
    if (!account) return [`there is no merchant account ${id} (${currency})`];
    if (account.currencyCode?.toUpperCase() !== currency) return [`merchant account ${id} settles in ${account.currencyCode ?? "an unknown currency"}, not ${currency}`];
    if (account.status && account.status !== "ACTIVE") return [`merchant account ${id} is ${account.status.toLowerCase()}`];
    return [];
  });
  if (problems.length > 0) return { ok: false, message: `Connected to Braintree in ${where}, but ${problems.join("; ")}.` };
  return { ok: true, message: `Connected to Braintree in ${where}. Merchant accounts: ${listed}.` };
};
