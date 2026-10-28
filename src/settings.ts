import { setting, type PluginContext } from "@spindlecommerce/plugin-sdk";

/** Staff fill these in under Settings › Plugins › Braintree; the keys can come from the environment instead. */
export const braintreeSettings = {
  environment: setting.select({
    label: "Environment",
    description: "Sandbox while testing, with the sandbox's own API keys. Production takes real payments.",
    options: [
      { value: "sandbox", label: "Sandbox" },
      { value: "production", label: "Production" },
    ],
    default: "sandbox",
  }),
  publicKey: setting.string({
    label: "Public key",
    description: "Braintree Control Panel › gear icon › API › API Keys. Keys belong to one environment: sandbox keys work only in the sandbox.",
    required: true,
    env: "BRAINTREE_PUBLIC_KEY",
  }),
  privateKey: setting.secret({
    label: "Private key",
    description: "Shown next to the public key (View, under Private Key). It also verifies Braintree's webhooks.",
    required: true,
    env: "BRAINTREE_PRIVATE_KEY",
  }),
  merchantAccounts: setting.string({
    label: "Merchant accounts",
    description:
      "A merchant account settles in one currency. Map each currency you sell in to one, as CURRENCY=merchant account ID, separated by commas. Braintree is offered only in these currencies. The IDs are under the gear icon › Business › Merchant Accounts.",
    placeholder: "GBP=shop_gbp, EUR=shop_eur",
    required: true,
  }),
};

export type BraintreeSettings = typeof braintreeSettings;
export type BraintreeContext = Pick<PluginContext<BraintreeSettings>, "settings" | "fetch">;

/** The merchant accounts setting is not a list of CURRENCY=ID entries. */
export class MerchantAccountsError extends Error {
  constructor(problem: string) {
    super(`Merchant accounts: ${problem}. List them as CURRENCY=merchant account ID, separated by commas, e.g. GBP=shop_gbp, EUR=shop_eur.`);
    this.name = "MerchantAccountsError";
  }
}

/**
 * `GBP=shop_gbp, EUR=shop_eur` → GBP → shop_gbp, EUR → shop_eur. Strict: an entry that is not
 * CURRENCY=ID, a currency listed twice or an account listed for two currencies is an error, never
 * skipped, so a typo cannot quietly take a currency off sale or charge it to the wrong account.
 */
export const parseMerchantAccounts = (value: string): Map<string, string> => {
  const accounts = new Map<string, string>();
  for (const entry of value.split(/[,\n]/).map((part) => part.trim())) {
    // Separators left at the end ("GBP=shop_gbp,") hold no entry.
    if (!entry) continue;
    const match = /^([A-Za-z]{3})\s*=\s*([^\s=,]+)$/.exec(entry);
    if (!match) throw new MerchantAccountsError(`"${entry}" is not CURRENCY=ID`);
    const currency = match[1]!.toUpperCase();
    const id = match[2]!;
    if (accounts.has(currency)) throw new MerchantAccountsError(`${currency} is listed twice`);
    const other = [...accounts].find(([, account]) => account === id);
    if (other) throw new MerchantAccountsError(`${id} is listed for both ${other[0]} and ${currency}, but a merchant account settles in one currency`);
    accounts.set(currency, id);
  }
  if (accounts.size === 0) throw new MerchantAccountsError("none are listed");
  return accounts;
};
