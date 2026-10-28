import { definePlugin } from "@spindlecommerce/plugin-sdk";
import { braintreeProvider, checkConnection } from "./provider.ts";
import { braintreeSettings } from "./settings.ts";

/**
 * Braintree (braintreepayments.com): payment methods that use the "braintree" provider take cards
 * and PayPal through Braintree's GraphQL API, captured, refunded and voided from the admin, with
 * disputes reported by webhook. See README.md.
 */
export const braintree = () =>
  definePlugin({
    name: "braintree",
    // The package's version (a test keeps them equal), shown in the admin.
    version: "1.0.0",
    // The plugin API this was written for, as a number: PLUGIN_API_VERSION would be the
    // installation's own, so it would always match.
    apiVersion: 1,
    title: "Braintree",
    description: "Cards and PayPal through Braintree: payments authorized or charged at checkout, captures, refunds and voids from the admin, and disputes by webhook.",
    settings: braintreeSettings,
    payments: [braintreeProvider],
    check: checkConnection,
  });

export default braintree;
