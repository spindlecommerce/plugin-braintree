# Braintree, a SpindleCommerce plugin

Card, PayPal and wallet payments through [Braintree](https://www.braintreepayments.com)'s GraphQL
API. The storefront collects the payment with Braintree's client SDK or Drop-in. The plugin
authorizes or charges it when the order is placed, staff capture, refund and cancel from the
admin, and disputes reach the orders by webhook.

## What it does

It adds one payment provider, `braintree`, for payment methods under Settings › Payments.

- **Sessions.** A payment session is a Braintree client token for the merchant account of the
  cart's currency. The storefront's Braintree client SDK or Drop-in uses it to turn what the
  customer enters into a payment method nonce.
- **Checkout.** Placing the order authorizes the nonce for the order's total, or charges it when
  the payment method captures at checkout. The transaction's order ID is the order number, so the
  Control Panel shows which order it paid for.
- **Declines.** A declined payment cancels the order and reopens the cart. Its message is the
  processor's response, such as "Insufficient Funds".
- **The admin.**
  - Capturing submits the authorization for settlement, in full or in part.
  - Refunding refunds a settled transaction, in full or in part.
  - Canceling an order voids its authorization.
- **Webhooks.** Disputes are recorded on their orders as they open and close. A declined settlement
  is recorded as a failure.
- **Amounts.** The platform's minor units become Braintree's decimal strings with ISO 4217's
  exponents: 4999 GBP is `49.99`, 1500 JPY is `1500` and 150000 HUF is `1500.00`.

## Setup

1. **Add the plugin** to your SpindleCommerce installation and deploy:

   ```bash
   pnpm add @spindlecommerce/plugin-braintree
   ```

   ```ts
   // ecom.config.ts
   import { braintree } from "@spindlecommerce/plugin-braintree";

   export default defineConfig({ plugins: [email(), braintree()] });
   ```

2. **Settings › Plugins › Braintree.**
   - Choose the environment: sandbox while testing, then production.
   - Enter the API keys from the Braintree Control Panel, under the gear icon › API › API Keys: the
     public key, and the private key (View, under Private Key). On a server, the
     `BRAINTREE_PUBLIC_KEY` and `BRAINTREE_PRIVATE_KEY` environment variables can supply them instead.
   - List the merchant accounts, one per currency you sell in (see [Settings](#settings)).
   - **Test connection** checks the keys, and that each merchant account exists and settles in its
     currency.

3. **Settings › Payments.** Add a payment method with the provider **Braintree**, for example
   "Card or PayPal", and choose its capture mode:
   - **Later** (authorize at checkout, capture on shipment): the order is authorized, and staff
     capture it from the order. Capture before the authorization expires.
   - **At checkout:** the order is paid when it is placed.

4. **Add a webhook** in the Control Panel, under the gear icon › API › Webhooks › Create New Webhook:
   - **Destination URL:** `https://<platform>/payments/webhooks/braintree`, for example
     `https://shop-api.example.com/payments/webhooks/braintree`. The API's base path, if it has
     one, comes first.
   - **Notifications:** Dispute Opened, Won, Lost, Accepted, Auto Accepted and Expired, and
     Transaction Settlement Declined (see [Webhooks](#webhooks)).

   Braintree signs notifications with the API keys, so there is no webhook secret to copy.

## Settings

- **Environment:** sandbox (the default) or production. API keys belong to one environment.
- **Public key** (`BRAINTREE_PUBLIC_KEY`), required.
- **Private key** (secret, `BRAINTREE_PRIVATE_KEY`), required. It also verifies webhooks.
- **Merchant accounts**, required: each currency you sell in, with the merchant account that takes
  it, as `CURRENCY=merchant account ID` separated by commas.
  - For example `GBP=shop_gbp, EUR=shop_eur`.
  - A merchant account settles in one currency, so Braintree is offered only in the currencies
    listed.
  - Find the IDs under the gear icon › Business › Merchant Accounts.
  - The list is read strictly. An entry that is not `CURRENCY=ID`, a currency listed twice, or one
    account listed for two currencies, is an error rather than skipped. Until it is fixed, Braintree
    is not offered, and **Test connection** says what is wrong.

## What the storefront sends

A nonce from Braintree's client SDK or Drop-in, made with the session's client token:

1. Choose a payment method whose `provider` is `braintree`, then call `cartPaymentSessionCreate`.
   Its `clientData` is `{ clientToken }`.
2. Create Braintree's Drop-in (or its client SDK) with the client token. The customer enters a card
   or chooses PayPal, and Braintree returns a payment method nonce.
3. Place the order with the nonce in `payment.token`, the storefront API's field for it.

```js
import dropin from "braintree-web-drop-in";

const { session } = (await gql(`mutation ($cartId: ID!) { cartPaymentSessionCreate(cartId: $cartId) {
  ... on CartPaymentSessionPayload { session { clientData } } } }`, { cartId })).cartPaymentSessionCreate;
const instance = await dropin.create({ authorization: session.clientData.clientToken, container: "#dropin" });

// On "Pay":
const { nonce } = await instance.requestPaymentMethod();
await gql(`mutation ($cartId: ID!, $key: String!, $nonce: String!) {
  checkoutPlaceOrder(cartId: $cartId, idempotencyKey: $key, payment: { token: $nonce }) {
    __typename
    ... on CheckoutPayload { order { number paymentStatus } }
    ... on PaymentDeclinedError { declineCode message }
  } }`, { cartId, key, nonce });
```

- **Nothing is charged before the order is placed,** and then for the order's total.
- **Nothing to pay.** `clientToken` is null when the total is zero: place the order directly.
- **Code calling the platform directly** (`placeOrder`) can send the nonce as `paymentData.nonce`.
- **A declined payment** returns `PaymentDeclinedError` and reopens the cart. A nonce can be used
  once, so ask Drop-in for a new one (`clearSelectedPaymentMethod()`, then
  `requestPaymentMethod()`) before placing the order again. The `declineCode` says why:

  | `declineCode` | Why |
  |---|---|
  | `processor_declined` | The bank declined. The message is the processor's response. |
  | `gateway_rejected` | Braintree's gateway rejected it: its fraud, AVS, CVV or duplicate checks, for example. |
  | `failed` | Braintree could not reach the processor. |
  | `payment_refused` | Braintree made no transaction, for example for a nonce that was used already or expired. |
  | `payment_incomplete` | The order came without a nonce. |
  | `currency_mismatch` | The merchant account takes another currency than the order's. The transaction was reversed: fix the merchant accounts setting. |

## Webhooks

| Braintree notification | Payment event | Effect on the order |
|---|---|---|
| `dispute_opened` | `dispute_opened`, with the disputed amount and Braintree's reason | An order event, and `order.payment_disputed` |
| `dispute_won`, `dispute_lost`, `dispute_accepted` | `dispute_closed`, with the reason `won`, `lost` or `accepted` | An order event |
| `dispute_auto_accepted`, `dispute_expired` | `dispute_closed`, with the reason `accepted` or `expired` (the reply-by date passed) | An order event |
| `transaction_settlement_declined` (ACH and SEPA debits) | `failed`, with the processor's settlement response | A failed transaction while the order awaits payment |
| `check`, Braintree's test, and every other kind | None | None: answered 200 |

- **Verification.** Notifications are checked as Braintree's SDKs check them. The `bt_signature`
  pair for this public key must be the HMAC-SHA1 of `bt_payload`, keyed with the SHA-1 of the
  private key, compared in constant time. Anything else is answered 400, without details.
- **Once each.** An event's ID is the notification's kind, subject ID and timestamp, so a
  notification is applied once however often Braintree delivers it.
- **Transaction IDs.** Notifications name transactions by the legacy IDs the Control Panel shows.
  Orders keep the GraphQL API's IDs, so the plugin converts them with Braintree's `idsFromLegacyIds`.
  The legacy ID is kept with each payment transaction, too.
- **Retries.** Braintree delivers a notification again every hour until it is answered: for up to
  24 hours in production, and 3 in the sandbox.

## Limitations

- **No storefront Drop-in yet.** The storefront integrates Braintree's Drop-in or client SDK itself
  (see [What the storefront sends](#what-the-storefront-sends)).
- **One currency per merchant account.** Braintree converts nothing, so each currency the store
  sells in needs a merchant account of its own, listed in the settings. Carts in other currencies are
  not offered Braintree.
- **One capture per authorization.** Capturing part of an authorization settles that part and
  releases the rest. Braintree refuses a second capture of the same order.
- **Refunds wait for settlement.** Braintree refunds only transactions that have settled, usually in
  its nightly batch. Until then, a refund fails with Braintree's reason.
- **Disputes are recorded, not answered.** Respond to them in the Control Panel.

## Develop

```bash
pnpm install
pnpm test
pnpm build
```

The tests run the plugin against a fake Braintree API. The plugin API it builds on is
[@spindlecommerce/plugin-sdk](https://www.npmjs.com/package/@spindlecommerce/plugin-sdk).

## Release

Each version is staged on npm and goes live when a maintainer approves it.

1. Raise `version` in `package.json` and in `src/index.ts`. A test checks they match.
2. Commit, then tag and push: for example `git tag v1.0.1 && git push origin main v1.0.1`.
3. The Release workflow tests, builds and stages the version, and creates the GitHub release.
4. Approve it on npmjs.com, under **Staged Packages**, with 2FA.

The workflow publishes with npm's trusted publishing, so it needs no token. Before its first release,
a maintainer links the package to the workflow:

```bash
npm trust github @spindlecommerce/plugin-braintree --repo spindlecommerce/plugin-braintree --file release.yml --allow-stage-publish
```

Run it just before tagging: npm drops a link that isn't used within 48 hours.

## License

MIT
