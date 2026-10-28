import { readFile } from "node:fs/promises";
import { InvalidStateError, PaymentDeclinedError, ValidationError, type AuthorizeInput, type PaymentSessionInput, type PluginContext } from "@spindlecommerce/plugin-sdk";
import { describe, expect, it } from "vitest";
import { BRAINTREE_VERSION, toAmount, toMinorUnits } from "../src/api.ts";
import { braintree } from "../src/index.ts";
import { braintreeProvider, checkConnection } from "../src/provider.ts";
import { MerchantAccountsError, parseMerchantAccounts, type BraintreeSettings } from "../src/settings.ts";
import { childText, parseXml, readNotification, verifyBraintreeSignature } from "../src/webhook.ts";
import { disputeXml, encodePayload, fakeBraintree, notificationXml, PRIVATE_KEY, PRODUCTION, PUBLIC_KEY, SANDBOX, sign, webhookRequest, type FakeBraintree } from "./fake-braintree.ts";

const ACCOUNTS = "GBP=shop_gbp, EUR=shop_eur, JPY=shop_jpy, HUF=shop_huf";

const quiet = () => {};

/** A plugin context built by hand, as the runtime would. Errors logged are kept. */
const contextFor = (fetch: typeof globalThis.fetch, settings: Partial<PluginContext<BraintreeSettings>["settings"]> = {}) => {
  const logged: unknown[][] = [];
  return {
    plugin: { name: "braintree", version: "1.0.0" },
    settings: { environment: "sandbox", publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY, merchantAccounts: ACCOUNTS, ...settings },
    fetch,
    logger: { trace: quiet, debug: quiet, info: quiet, warn: quiet, error: (...args: unknown[]) => logged.push(args), fatal: quiet },
    logged,
  } as unknown as PluginContext<BraintreeSettings> & { logged: unknown[][] };
};

const sessionInput = (patch: Partial<PaymentSessionInput> = {}): PaymentSessionInput => ({
  cartId: "01900000-0000-7000-8000-0000000000c1",
  methodCode: "braintree_card",
  amount: 4999,
  currency: "GBP",
  locale: "en-GB",
  email: "ana@example.test",
  customerId: null,
  billingAddress: null,
  shippingAddress: null,
  lines: [],
  captureImmediately: false,
  previous: null,
  ...patch,
});

const authorizeInput = (patch: Partial<AuthorizeInput> = {}): AuthorizeInput => ({
  orderId: "01900000-0000-7000-8000-0000000000aa",
  orderNumber: "UK-000042",
  cartId: "01900000-0000-7000-8000-0000000000c1",
  amount: 4999,
  currency: "GBP",
  paymentData: { nonce: "fake-valid-nonce" },
  captureImmediately: false,
  session: { merchantAccountId: "shop_gbp" },
  ...patch,
});

/** An order's authorized (or, with `captureImmediately`, charged) transaction. */
const paid = async (api: FakeBraintree, patch: Partial<AuthorizeInput> = {}) => {
  const result = await braintreeProvider.authorize(authorizeInput(patch), contextFor(api.fetch));
  return result.pspReference!;
};

const declined = (declineCode: string, message: string | RegExp) => ({ constructor: PaymentDeclinedError, declineCode, message: typeof message === "string" ? message : expect.stringMatching(message) });

describe("Settings", () => {
  it("map currencies to merchant accounts, strictly", () => {
    expect([...parseMerchantAccounts("GBP=shop_gbp, eur = shop_eur,\nJPY=shop-jpy_2,")]).toEqual([
      ["GBP", "shop_gbp"],
      ["EUR", "shop_eur"],
      ["JPY", "shop-jpy_2"],
    ]);
    const refused = (value: string, problem: string) => expect(() => parseMerchantAccounts(value)).toThrow(problem);
    refused("GBP shop_gbp", '"GBP shop_gbp" is not CURRENCY=ID');
    refused("GBP=shop_gbp, EURO=shop_eur", '"EURO=shop_eur" is not CURRENCY=ID');
    refused("GBP=", '"GBP=" is not CURRENCY=ID');
    refused("GBP=shop gbp", '"GBP=shop gbp" is not CURRENCY=ID');
    refused("GBP=shop_gbp, gbp=shop_other", "GBP is listed twice");
    refused("GBP=shop, EUR=shop", "shop is listed for both GBP and EUR, but a merchant account settles in one currency");
    refused(" , ", "none are listed");
    expect(() => parseMerchantAccounts("GBP")).toThrow(MerchantAccountsError);
  });

  it("offer the provider only in the currencies with a merchant account", async () => {
    const ctx = contextFor(fakeBraintree().fetch);
    const offered = (currency: string) => braintreeProvider.isAvailable!({ currency, countryCode: "GB", amount: 4999 }, ctx);
    expect(await Promise.all(["GBP", "EUR", "JPY", "HUF", "USD", "CHF"].map(offered))).toEqual([true, true, true, true, false, false]);
    // A malformed setting throws, which hides the provider's methods (and the platform logs why).
    expect(() => braintreeProvider.isAvailable!({ currency: "GBP", countryCode: "GB", amount: 4999 }, contextFor(fakeBraintree().fetch, { merchantAccounts: "GBP:shop_gbp" }))).toThrow(MerchantAccountsError);
  });
});

describe("Sessions", () => {
  it("create a client token for the currency's merchant account", async () => {
    const api = fakeBraintree();
    const session = await braintreeProvider.createSession!(sessionInput({ currency: "EUR" }), contextFor(api.fetch));
    expect(session).toEqual({ data: { merchantAccountId: "shop_eur" }, clientData: { clientToken: "fake-client-token-for-shop_eur" } });
    expect(api.calls).toEqual([
      {
        url: SANDBOX,
        operation: "createClientToken",
        query: expect.stringContaining("createClientToken(input: $input) { clientToken }"),
        variables: { input: { clientToken: { merchantAccountId: "shop_eur" } } },
        headers: {
          authorization: `Basic ${Buffer.from("test-public-key:test-private-key").toString("base64")}`,
          "braintree-version": BRAINTREE_VERSION,
          "content-type": "application/json",
          accept: "application/json",
        },
      },
    ]);
  });

  it("use the production API in production, and need no token for nothing to pay", async () => {
    const live = fakeBraintree({ environment: "production" });
    await braintreeProvider.createSession!(sessionInput(), contextFor(live.fetch, { environment: "production" }));
    expect(live.calls[0]!.url).toBe(PRODUCTION);
    const api = fakeBraintree();
    expect(await braintreeProvider.createSession!(sessionInput({ amount: 0 }), contextFor(api.fetch))).toEqual({ data: { merchantAccountId: "shop_gbp" }, clientData: { clientToken: null } });
    expect(api.calls).toEqual([]);
  });

  it("refuse a currency without a merchant account, and one Braintree does not know", async () => {
    const api = fakeBraintree();
    await expect(braintreeProvider.createSession!(sessionInput({ currency: "USD" }), contextFor(api.fetch))).rejects.toMatchObject({ constructor: InvalidStateError, message: "Braintree does not take payments in USD here" });
    const unknown = braintreeProvider.createSession!(sessionInput(), contextFor(api.fetch, { merchantAccounts: "GBP=shop_gone" }));
    await expect(unknown).rejects.toMatchObject({ constructor: InvalidStateError, message: "Braintree cannot take this payment: Merchant account ID is invalid." });
  });
});

describe("Authorize", () => {
  it("authorizes the nonce for the order's total, labelled with the order number", async () => {
    const api = fakeBraintree();
    const result = await braintreeProvider.authorize(authorizeInput(), contextFor(api.fetch));
    const [call] = api.calls;
    expect(call).toMatchObject({ operation: "authorizePaymentMethod", variables: { input: { paymentMethodId: "fake-valid-nonce", transaction: { amount: "49.99", merchantAccountId: "shop_gbp", orderId: "UK-000042" } } } });
    expect(call!.query).toContain("authorizePaymentMethod(input: $input) { transaction {");
    const transaction = api.transactions.get(result.pspReference!)!;
    expect(result).toEqual({ status: "authorized", pspReference: transaction.id, raw: { status: "AUTHORIZED", legacyId: transaction.legacyId, merchantAccountId: "shop_gbp" } });
    // The storefront API's checkoutPlaceOrder sends it as `payment: { token }`.
    await braintreeProvider.authorize(authorizeInput({ paymentData: { token: "fake-valid-nonce" } }), contextFor(api.fetch));
    expect(api.calls.at(-1)!.variables.input.paymentMethodId).toBe("fake-valid-nonce");
  });

  it("charges it when the method captures at checkout", async () => {
    const api = fakeBraintree();
    const result = await braintreeProvider.authorize(authorizeInput({ captureImmediately: true }), contextFor(api.fetch));
    expect(api.calls[0]).toMatchObject({ operation: "chargePaymentMethod", variables: { input: { transaction: { amount: "49.99" } } } });
    expect(result).toMatchObject({ status: "captured", raw: { status: "SUBMITTED_FOR_SETTLEMENT" } });
  });

  it("sends amounts as decimal strings in the currency's own minor units", async () => {
    const api = fakeBraintree();
    const amounts = async (amount: number, currency: string) => {
      await braintreeProvider.authorize(authorizeInput({ amount, currency }), contextFor(api.fetch));
      return api.calls.at(-1)!.variables.input.transaction;
    };
    expect(await amounts(1500, "JPY")).toMatchObject({ amount: "1500", merchantAccountId: "shop_jpy" });
    // Forints have two decimals in ISO 4217, in the platform and at Braintree (Intl says none).
    expect(await amounts(150_000, "HUF")).toMatchObject({ amount: "1500.00", merchantAccountId: "shop_huf" });
    expect(await amounts(5, "EUR")).toMatchObject({ amount: "0.05", merchantAccountId: "shop_eur" });
    expect([toAmount(1999, "USD"), toAmount(1500, "JPY"), toAmount(150_000, "HUF"), toAmount(1234, "KWD"), toAmount(7, "GBP")]).toEqual(["19.99", "1500", "1500.00", "1.234", "0.07"]);
    expect([toMinorUnits("19.99", "USD"), toMinorUnits("1500", "JPY"), toMinorUnits("1500.00", "HUF"), toMinorUnits("1.234", "KWD"), toMinorUnits("250.0", "USD"), toMinorUnits("100", "USD")]).toEqual([1999, 1500, 150_000, 1234, 25_000, 10_000]);
    expect([toMinorUnits("12.345", "GBP"), toMinorUnits("", "GBP"), toMinorUnits("1,00", "GBP"), toMinorUnits(null, "GBP")]).toEqual([1235, null, null, null]);
  });

  it("declines with the processor's response text", async () => {
    const api = fakeBraintree();
    const ctx = contextFor(api.fetch);
    await expect(braintreeProvider.authorize(authorizeInput({ paymentData: { nonce: "fake-processor-declined-visa-nonce" } }), ctx)).rejects.toMatchObject(declined("processor_declined", "Do Not Honor"));
    await expect(braintreeProvider.authorize(authorizeInput({ paymentData: { nonce: "fake-gateway-rejected-fraud-nonce" } }), ctx)).rejects.toMatchObject(declined("gateway_rejected", "Braintree rejected the payment (fraud)"));
    // No transaction at all: a nonce already used, or unknown. Nothing was charged.
    await expect(braintreeProvider.authorize(authorizeInput({ paymentData: { nonce: "fake-consumed-nonce" } }), ctx)).rejects.toMatchObject(declined("payment_refused", "Unknown or expired single-use payment method."));
    expect(ctx.logged).toEqual([]);
  });

  it("declines an order sent without a nonce, so its cart reopens", async () => {
    const api = fakeBraintree();
    await expect(braintreeProvider.authorize(authorizeInput({ paymentData: {} }), contextFor(api.fetch))).rejects.toMatchObject(declined("payment_incomplete", "No Braintree payment method nonce was sent with the order"));
    await expect(braintreeProvider.authorize(authorizeInput({ paymentData: { nonce: "  " } }), contextFor(api.fetch))).rejects.toMatchObject({ declineCode: "payment_incomplete" });
    expect(api.calls).toEqual([]);
    // Nothing to pay: no transaction.
    expect(await braintreeProvider.authorize(authorizeInput({ amount: 0, paymentData: {} }), contextFor(api.fetch))).toEqual({ status: "captured", pspReference: null });
  });

  it("looks up the transaction a webhook reported when the platform places the order itself", async () => {
    const api = fakeBraintree();
    const ctx = contextFor(api.fetch);
    const authorized = await paid(api);
    const charged = await paid(api, { captureImmediately: true });
    api.reset();
    expect(await braintreeProvider.authorize(authorizeInput({ paymentData: { pspReference: authorized } }), ctx)).toMatchObject({ status: "authorized", pspReference: authorized });
    expect(api.calls).toEqual([expect.objectContaining({ operation: "node", variables: { id: authorized } })]);
    expect(await braintreeProvider.authorize(authorizeInput({ paymentData: { pspReference: charged } }), ctx)).toMatchObject({ status: "captured", pspReference: charged });
    await expect(braintreeProvider.authorize(authorizeInput({ amount: 5000, paymentData: { pspReference: authorized } }), ctx)).rejects.toMatchObject(declined("amount_mismatch", /does not match/));
    await expect(braintreeProvider.authorize(authorizeInput({ paymentData: { pspReference: "fake-missing" } }), ctx)).rejects.toMatchObject(declined("payment_incomplete", "The Braintree transaction was not found"));
    // Not the processor's "Approved" of the authorization: what happened since.
    api.transaction(authorized).status = "VOIDED";
    await expect(braintreeProvider.authorize(authorizeInput({ paymentData: { pspReference: authorized } }), ctx)).rejects.toMatchObject(declined("voided", "The payment was voided"));
    // A CVV rejection comes after the processor approved.
    Object.assign(api.transaction(authorized), { status: "GATEWAY_REJECTED", statusHistory: [{ __typename: "GatewayRejectedEvent", gatewayRejectionReason: "CVV" }] });
    await expect(braintreeProvider.authorize(authorizeInput({ paymentData: { pspReference: authorized } }), ctx)).rejects.toMatchObject(declined("gateway_rejected", "Braintree rejected the payment (cvv)"));
  });

  it("gives back a transaction made in another currency than the order's", async () => {
    const api = fakeBraintree();
    // A typo in the settings: GBP mapped to the USD account. £49.99 must not become $49.99.
    const failure = braintreeProvider.authorize(authorizeInput(), contextFor(api.fetch, { merchantAccounts: "GBP=shop_usd" }));
    await expect(failure).rejects.toMatchObject(declined("currency_mismatch", "Braintree merchant account shop_usd takes USD, not GBP: the plugin's merchant accounts setting maps GBP to it"));
    expect(api.calls.map((c) => c.operation)).toEqual(["authorizePaymentMethod", "reverseTransaction"]);
    expect([...api.transactions.values()].map((t) => t.status)).toEqual(["VOIDED"]);
  });
});

describe("Capture, refund and void", () => {
  const order = (pspReference: string | null, amount = 4999) => ({ orderId: "01900000-0000-7000-8000-0000000000aa", amount, currency: "GBP", pspReference });

  it("captures all or part of an authorization", async () => {
    const api = fakeBraintree();
    const ctx = contextFor(api.fetch);
    const id = await paid(api);
    expect(await braintreeProvider.capture(order(id, 3000), ctx)).toEqual({ pspReference: id, raw: { status: "SUBMITTED_FOR_SETTLEMENT", legacyId: api.transaction(id).legacyId, amount: "30.00" } });
    expect(api.calls.at(-1)).toMatchObject({ operation: "captureTransaction", variables: { input: { transactionId: id, transaction: { amount: "30.00" } } } });
    expect(api.transaction(id)).toMatchObject({ status: "SUBMITTED_FOR_SETTLEMENT", amount: { value: "30.00" } });
    // Braintree's refusals reach staff as the reason.
    await expect(braintreeProvider.capture(order(id, 1999), ctx)).rejects.toMatchObject({ constructor: InvalidStateError, message: "Braintree: Cannot submit for settlement unless status is authorized." });
    await expect(braintreeProvider.capture(order(null), ctx)).rejects.toMatchObject({ constructor: InvalidStateError, message: "This order has no Braintree transaction" });
  });

  it("refunds settled transactions, with the refund's own id as its reference", async () => {
    const api = fakeBraintree();
    const ctx = contextFor(api.fetch);
    const id = await paid(api, { captureImmediately: true });
    await expect(braintreeProvider.refund(order(id, 1000), ctx)).rejects.toMatchObject({ constructor: InvalidStateError, message: "Braintree: Cannot refund a transaction unless it is settled." });
    api.settle(id);
    const refund = await braintreeProvider.refund(order(id, 1000), ctx);
    expect(api.calls.at(-1)).toMatchObject({ operation: "refundTransaction", variables: { input: { transactionId: id, refund: { amount: "10.00" } } } });
    const recorded = api.refunds.get(refund.pspReference!)!;
    expect(refund).toEqual({ pspReference: recorded.id, raw: { status: "SUBMITTED_FOR_SETTLEMENT", legacyId: recorded.legacyId, transaction: id } });
    expect(refund.pspReference).not.toBe(id);
    expect(recorded).toMatchObject({ amount: { value: "10.00", currencyCode: "GBP" }, refundedTransaction: { id } });
    await expect(braintreeProvider.refund(order(id, 4000), ctx)).rejects.toThrow("Braintree: Refund amount is too large.");
  });

  it("voids an authorization, and refunds a settled payment in full", async () => {
    const api = fakeBraintree();
    const ctx = contextFor(api.fetch);
    const authorized = await paid(api);
    expect(await braintreeProvider.void({ orderId: "01900000-0000-7000-8000-0000000000aa", pspReference: authorized }, ctx)).toEqual({
      pspReference: authorized,
      raw: { reversal: "void", status: "VOIDED", legacyId: api.transaction(authorized).legacyId },
    });
    expect(api.calls.at(-1)).toMatchObject({ operation: "reverseTransaction", variables: { input: { transactionId: authorized } } });
    // Voided already (here just now; or in the Control Panel): nothing is left to release.
    expect(await braintreeProvider.void({ orderId: "01900000-0000-7000-8000-0000000000aa", pspReference: authorized }, ctx)).toEqual({ pspReference: authorized, raw: { status: "VOIDED", released: false } });

    const settled = await paid(api, { captureImmediately: true });
    api.settle(settled);
    const reversed = await braintreeProvider.void({ orderId: "", pspReference: settled }, ctx);
    expect(reversed).toMatchObject({ raw: { reversal: "refund", status: "SUBMITTED_FOR_SETTLEMENT" } });
    expect(api.refunds.get(reversed.pspReference!)).toMatchObject({ amount: { value: "49.99" }, refundedTransaction: { id: settled } });
  });

  it("releases nothing for a checkout that has only its session, or an authorization that expired", async () => {
    const api = fakeBraintree();
    const ctx = contextFor(api.fetch);
    expect(await braintreeProvider.void({ orderId: "", pspReference: null, session: { merchantAccountId: "shop_gbp" } }, ctx)).toEqual({ pspReference: null });
    expect(api.calls).toEqual([]);
    const expired = await paid(api);
    api.transaction(expired).status = "AUTHORIZATION_EXPIRED";
    expect(await braintreeProvider.void({ orderId: "01900000-0000-7000-8000-0000000000aa", pspReference: expired }, ctx)).toEqual({ pspReference: expired, raw: { status: "AUTHORIZATION_EXPIRED", released: false } });
    // A settled refund cannot be reversed: staff hear why.
    const refundable = await paid(api, { captureImmediately: true });
    api.settle(refundable);
    api.transaction(refundable).status = "SETTLEMENT_DECLINED";
    await expect(braintreeProvider.void({ orderId: "01900000-0000-7000-8000-0000000000aa", pspReference: refundable }, ctx)).rejects.toMatchObject({ constructor: InvalidStateError, message: /^Braintree: Transaction can only be voided/ });
  });
});

describe("Webhooks", () => {
  const events = async (api: FakeBraintree, request: Request) => (await braintreeProvider.webhook!(request, contextFor(api.fetch))).events;

  it("reports disputes against the transaction authorize recorded", async () => {
    const api = fakeBraintree();
    const id = await paid(api, { captureImmediately: true });
    const { legacyId } = api.transaction(id);
    api.reset();
    const opened = await events(api, webhookRequest(disputeXml("dispute_opened", { id: "fakedispute1", transactionId: legacyId, amount: "49.99" })));
    expect(opened).toEqual([
      {
        id: "dispute_opened:fakedispute1:2026-10-28T12:00:00Z",
        type: "dispute_opened",
        pspReference: id,
        amount: 4999,
        currency: "GBP",
        reason: "fraud",
        raw: { kind: "dispute_opened", dispute: "fakedispute1", disputeKind: "chargeback", status: "open", transaction: legacyId },
      },
    ]);
    // Notifications carry legacy ids: converted to the GraphQL id authorize returned.
    expect(api.calls).toEqual([expect.objectContaining({ operation: "idsFromLegacyIds", variables: { input: { ids: [{ legacyId, type: "TRANSACTION" }] } } })]);
    // The same notification again has the same id, so the platform applies it once.
    expect((await events(api, webhookRequest(disputeXml("dispute_opened", { id: "fakedispute1", transactionId: legacyId, amount: "49.99" }))))[0]!.id).toBe(opened[0]!.id);

    const closed = async (kind: string) => (await events(api, webhookRequest(disputeXml(kind, { transactionId: legacyId, status: kind.slice(8) }, "2026-12-01T09:30:00Z"))))[0];
    expect(await closed("dispute_won")).toMatchObject({ id: "dispute_won:fakedispute1:2026-12-01T09:30:00Z", type: "dispute_closed", pspReference: id, reason: "won", amount: 2500 });
    expect(await closed("dispute_lost")).toMatchObject({ type: "dispute_closed", reason: "lost" });
    expect(await closed("dispute_accepted")).toMatchObject({ type: "dispute_closed", reason: "accepted" });
    expect(await closed("dispute_auto_accepted")).toMatchObject({ type: "dispute_closed", reason: "accepted" });
    expect(await closed("dispute_expired")).toMatchObject({ type: "dispute_closed", reason: "expired" });
  });

  it("reports a declined settlement as a failure", async () => {
    const api = fakeBraintree();
    const subject = `<transaction><id>fakebank1</id><status>settlement_declined</status><type>sale</type><currency-iso-code>EUR</currency-iso-code><amount>100.00</amount><processor-settlement-response-text>Insufficient funds</processor-settlement-response-text></transaction>`;
    expect(await events(api, webhookRequest(notificationXml("transaction_settlement_declined", subject)))).toEqual([
      {
        id: "transaction_settlement_declined:fakebank1:2026-10-28T12:00:00Z",
        type: "failed",
        pspReference: api.globalId("transaction", "fakebank1"),
        amount: 10_000,
        currency: "EUR",
        reason: "Insufficient funds",
        raw: { kind: "transaction_settlement_declined", status: "settlement_declined", transaction: "fakebank1" },
      },
    ]);
  });

  it("acknowledges Braintree's check and other kinds without events", async () => {
    const api = fakeBraintree();
    for (const [kind, subject] of [
      ["check", `<check type="boolean">true</check>`],
      ["dispute_under_review", `<dispute><id>fakedispute2</id><transaction><id>fake1</id></transaction></dispute>`],
      ["subscription_charged_successfully", `<subscription><id>fakesub1</id></subscription>`],
      ["transaction_settled", `<transaction><id>fake1</id></transaction>`],
    ]) {
      expect(await braintreeProvider.webhook!(webhookRequest(notificationXml(kind!, subject!)), contextFor(api.fetch))).toEqual({ events: [] });
    }
    expect(api.calls).toEqual([]);
  });

  it("refuses notifications it cannot verify", async () => {
    const api = fakeBraintree();
    const xml = disputeXml("dispute_opened", { transactionId: "fake1" });
    const refused = (request: Request) => expect(braintreeProvider.webhook!(request, contextFor(api.fetch))).rejects.toMatchObject({ constructor: ValidationError, message: "Invalid Braintree webhook signature" });
    await refused(webhookRequest(xml, { privateKey: "fake-other-private-key" }));
    await refused(webhookRequest(xml, { publicKey: "fake-other-public-key" }));
    const payload = encodePayload(xml);
    // Signed, then changed: a larger amount.
    await refused(webhookRequest(xml, { payload: encodePayload(xml.replaceAll("25.00", "2500.00")), signature: sign(payload) }));
    await refused(webhookRequest(xml, { payload: `${payload}<script>`, signature: sign(`${payload}<script>`) }));
    await refused(new Request("http://ecom.test/payments/webhooks/braintree", { method: "POST", body: JSON.stringify({ bt_signature: sign(payload), bt_payload: payload }) }));
    await refused(new Request("http://ecom.test/payments/webhooks/braintree", { method: "POST" }));
    expect(api.calls).toEqual([]);
  });

  it("verifies signatures as Braintree's SDKs do", () => {
    const keys = { publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY };
    const payload = encodePayload(notificationXml("check", `<check type="boolean">true</check>`));
    expect(verifyBraintreeSignature(keys, sign(payload), payload)).toBe(true);
    // Several API keys sign each notification; the pair for this public key counts.
    expect(verifyBraintreeSignature(keys, `fake-other-public-key|${"0".repeat(40)}&${sign(payload)}`, payload)).toBe(true);
    // Signed with a trailing newline that did not arrive.
    expect(verifyBraintreeSignature(keys, sign(payload), payload.replace(/\n$/, ""))).toBe(true);
    expect(verifyBraintreeSignature(keys, sign(payload).toUpperCase(), payload)).toBe(false);
    expect(verifyBraintreeSignature(keys, sign(payload).slice(0, -2), payload)).toBe(false);
    expect(verifyBraintreeSignature(keys, `${PUBLIC_KEY}|`, payload)).toBe(false);
    expect(verifyBraintreeSignature(keys, "", payload)).toBe(false);
  });

  it("reads the XML Braintree sends", () => {
    const notification = readNotification(encodePayload(disputeXml("dispute_opened", { transactionId: "fake1", reason: "product_not_received" })));
    expect(notification).toMatchObject({ kind: "dispute_opened", timestamp: "2026-10-28T12:00:00Z", subject: { name: "subject" } });
    const document = parseXml(`<?xml version="1.0"?><a x="1" y='2'><b>Tom &amp; Jerry &#233;&#x41;</b><c nil="true"/><d><![CDATA[<raw>]]></d><!-- note --></a>`);
    const a = document.children[0]!;
    expect(a.attributes).toEqual({ x: "1", y: "2" });
    expect([childText(a, "b"), childText(a, "c"), childText(a, "d"), childText(a, "e")]).toEqual(["Tom & Jerry éA", null, "<raw>", null]);
    expect(() => parseXml("<a><b></a>")).toThrow("Malformed XML");
    expect(() => parseXml("<a>")).toThrow("Malformed XML");
    expect(() => parseXml("<!DOCTYPE a><a/>")).toThrow("Malformed XML");
  });
});

describe("Braintree's errors", () => {
  it("are told apart from declines and refusals", async () => {
    const api = fakeBraintree();
    // Wrong keys: Braintree answers 200 with an AUTHENTICATION error.
    const wrongKeys = contextFor(api.fetch, { privateKey: "fake-wrong-private-key" });
    await expect(braintreeProvider.createSession!(sessionInput(), wrongKeys)).rejects.toThrow("Braintree: Authentication credentials are invalid.");
    await expect(braintreeProvider.capture({ orderId: "o", amount: 100, currency: "GBP", pspReference: "fake-id" }, wrongKeys)).rejects.not.toBeInstanceOf(InvalidStateError);
    // At checkout no transaction came of it, so the order is declined, and the error logged for staff.
    await expect(braintreeProvider.authorize(authorizeInput(), wrongKeys)).rejects.toMatchObject(declined("payment_refused", "Authentication credentials are invalid."));
    expect(wrongKeys.logged).toEqual([[{ errors: [expect.objectContaining({ extensions: { errorClass: "AUTHENTICATION" } })] }, "Braintree refused to create a transaction"]]);

    // An outage page instead of a GraphQL answer.
    api.answerNext("createClientToken", () => new Response("<html>Service Unavailable</html>", { status: 503 }));
    await expect(braintreeProvider.createSession!(sessionInput(), contextFor(api.fetch))).rejects.toThrow("Braintree answered 503: <html>Service Unavailable</html>");
    // A GraphQL error with no data.
    api.answerNext("captureTransaction", () => Response.json({ data: null, errors: [{ message: "Internal error", extensions: { errorClass: "INTERNAL" } }] }));
    await expect(braintreeProvider.capture({ orderId: "o", amount: 100, currency: "GBP", pspReference: "fake-id" }, contextFor(api.fetch))).rejects.toThrow("Braintree: Internal error");
  });
});

describe("Test connection", () => {
  it("pings Braintree and checks each merchant account's currency", async () => {
    const api = fakeBraintree();
    api.state.pageSize = 2;
    expect(await checkConnection(contextFor(api.fetch))).toEqual({
      ok: true,
      message: "Connected to Braintree in the sandbox. Merchant accounts: shop_gbp (GBP), shop_eur (EUR), shop_jpy (JPY), shop_huf (HUF).",
    });
    expect(api.calls.map((c) => [c.operation, c.variables])).toEqual([
      ["ping", undefined],
      ["viewer", { after: null }],
      ["viewer", { after: "2" }],
      ["viewer", { after: "4" }],
    ]);
    const live = fakeBraintree({ environment: "production" });
    expect(await checkConnection(contextFor(live.fetch, { environment: "production", merchantAccounts: "USD=shop_usd" }))).toEqual({ ok: true, message: "Connected to Braintree in production. Merchant accounts: shop_usd (USD)." });
  });

  it("says what is wrong", async () => {
    const api = fakeBraintree();
    api.state.merchantAccounts.push({ id: "shop_chf", currencyCode: "CHF", status: "SUSPENDED" });
    expect(await checkConnection(contextFor(api.fetch, { merchantAccounts: "GBP=shop_usd, EUR=shop_eur, SEK=shop_sek, CHF=shop_chf" }))).toEqual({
      ok: false,
      message: "Connected to Braintree in the sandbox, but merchant account shop_usd settles in USD, not GBP; there is no merchant account shop_sek (SEK); merchant account shop_chf is suspended.",
    });
    expect(await checkConnection(contextFor(api.fetch, { publicKey: "fake-wrong-public-key" }))).toEqual({
      ok: false,
      message: "Braintree refused the API keys in the sandbox: check both keys, and that they are sandbox keys.",
    });
    expect(await checkConnection(contextFor(api.fetch, { merchantAccounts: "GBP=shop_gbp; EUR=shop_eur" }))).toEqual({
      ok: false,
      message: 'Merchant accounts: "GBP=shop_gbp; EUR=shop_eur" is not CURRENCY=ID. List them as CURRENCY=merchant account ID, separated by commas, e.g. GBP=shop_gbp, EUR=shop_eur.',
    });
    api.answerNext("ping", () => new Response("Bad gateway", { status: 502 }));
    expect(await checkConnection(contextFor(api.fetch))).toEqual({ ok: false, message: "Could not reach Braintree: Braintree answered 502: Bad gateway" });
  });

  it("passes when Braintree will not list merchant accounts, saying they were not checked", async () => {
    const api = fakeBraintree();
    api.answerNext("viewer", () => Response.json({ data: { viewer: null }, errors: [{ message: "Not authorized to view merchant accounts.", extensions: { errorClass: "AUTHORIZATION" } }] }));
    expect(await checkConnection(contextFor(api.fetch, { merchantAccounts: "GBP=shop_gbp" }))).toEqual({
      ok: true,
      message: "Connected to Braintree in the sandbox. Merchant accounts: shop_gbp (GBP). Braintree did not list its merchant accounts, so they were not checked (Braintree: Not authorized to view merchant accounts.).",
    });
  });
});

describe("The plugin", () => {
  it("offers the braintree payment provider, its settings and a connection check, for plugin API 1", () => {
    const plugin = braintree();
    expect(plugin).toMatchObject({ name: "braintree", apiVersion: 1, title: "Braintree" });
    expect(plugin.payments?.map((provider) => provider.code)).toEqual(["braintree"]);
    expect(plugin.check).toBe(checkConnection);
    expect(plugin.settings).toMatchObject({
      environment: { type: "select", default: "sandbox", options: [{ value: "sandbox" }, { value: "production" }] },
      publicKey: { type: "string", required: true, env: "BRAINTREE_PUBLIC_KEY" },
      privateKey: { type: "secret", required: true, env: "BRAINTREE_PRIVATE_KEY" },
      merchantAccounts: { type: "string", required: true },
    });
  });

  it("reports the package's version", async () => {
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(braintree().version).toBe(version);
  });
});
