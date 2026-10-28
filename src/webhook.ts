import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Braintree's webhook notifications: a form-encoded POST of `bt_signature` and `bt_payload`, the
 * payload being base64 XML. Read without an XML library: only a few fields are needed.
 */

/** Base64 and the newlines Braintree wraps it with; Braintree's SDKs refuse anything else. */
const PAYLOAD = /^[A-Za-z0-9+=/\n]+$/;

/**
 * Checked as Braintree's server SDKs check it: `bt_signature` holds `<public key>|<signature>`
 * pairs joined by `&`, one per API key; the signature for this public key must be the hex
 * HMAC-SHA1 of the payload, keyed with the SHA-1 digest of the private key, compared in constant
 * time. The SDKs accept the payload with a trailing newline too.
 */
export const verifyBraintreeSignature = (keys: { publicKey: string; privateKey: string }, signature: string, payload: string): boolean => {
  if (!PAYLOAD.test(payload)) return false;
  const pair = signature
    .split("&")
    .map((part) => part.split("|"))
    .find((parts) => parts.length >= 2 && parts[0] === keys.publicKey);
  const given = Buffer.from(pair?.[1] ?? "");
  if (given.length === 0) return false;
  const key = createHash("sha1").update(keys.privateKey).digest();
  return [payload, `${payload}\n`].some((signed) => {
    const expected = Buffer.from(createHmac("sha1", key).update(signed).digest("hex"));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
};

// ---------------------------------------------------------------- XML

export type XmlElement = { name: string; attributes: Record<string, string>; children: XmlElement[]; text: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    return ENTITIES[name] ?? entity;
  });

const ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
// Groups: 1 CDATA, 2 closing slash, 3 tag name, 4 attributes, 5 self-closing slash, 6 text, 7 a stray "<".
const TOKEN = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/g;

/** Elements, attributes and text, as Braintree writes them; no DTDs, namespaces or mixed content. */
export const parseXml = (xml: string): XmlElement => {
  const document: XmlElement = { name: "#document", attributes: {}, children: [], text: "" };
  const open = [document];
  for (const token of xml.matchAll(TOKEN)) {
    const parent = open.at(-1)!;
    const [, cdata, closing, name, attributes, selfClosing, text, stray] = token;
    if (stray !== undefined) throw new Error("Malformed XML");
    if (cdata !== undefined) parent.text += cdata;
    else if (text !== undefined) parent.text += decodeEntities(text);
    else if (name !== undefined && closing) {
      if (parent.name !== name || open.length === 1) throw new Error(`Malformed XML: unexpected </${name}>`);
      open.pop();
    } else if (name !== undefined) {
      const element: XmlElement = { name, attributes: {}, children: [], text: "" };
      for (const [, key, double, single] of (attributes ?? "").matchAll(ATTRIBUTE)) element.attributes[key!] = decodeEntities(double ?? single ?? "");
      parent.children.push(element);
      if (!selfClosing) open.push(element);
    }
  }
  if (open.length !== 1) throw new Error(`Malformed XML: <${open.at(-1)!.name}> is not closed`);
  return document;
};

export const child = (element: XmlElement | null | undefined, name: string) => element?.children.find((c) => c.name === name) ?? null;

/** The trimmed text of a child element; null when it is missing, empty or `nil="true"`. */
export const childText = (element: XmlElement | null | undefined, name: string): string | null => {
  const found = child(element, name);
  if (!found || found.attributes.nil === "true") return null;
  return found.text.trim() || null;
};

export type BraintreeNotification = { kind: string | null; timestamp: string | null; subject: XmlElement | null };

/** A verified payload's notification: its kind, when it happened and its subject (a dispute, a transaction, …). */
export const readNotification = (payload: string): BraintreeNotification => {
  const notification = child(parseXml(Buffer.from(payload, "base64").toString("utf8")), "notification");
  if (!notification) throw new Error("The Braintree webhook payload holds no notification");
  const subject = child(notification, "subject");
  // Some kinds wrap their subject in an API error response.
  return { kind: childText(notification, "kind"), timestamp: childText(notification, "timestamp"), subject: child(subject, "api-error-response") ?? subject };
};
