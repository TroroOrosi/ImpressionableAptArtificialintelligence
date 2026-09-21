import test from "node:test";
import assert from "node:assert/strict";
import { addTrustedDomain, isForbiddenIp, isTrustedDomain, publicFetchPolicy, readBodyLimited, validatePublicUrl, validateRedirectTarget } from "./urlSafety";

test("SSRF IP classifier rejects local, private, link-local, multicast and unspecified ranges", () => {
  for (const address of [
    "0.0.0.0","10.0.0.1","127.0.0.1","169.254.169.254","172.16.0.1","192.168.1.1",
    "100.100.100.200","224.0.0.1","255.255.255.255","::","::1","fc00::1","fd00::1","fe80::1","ff02::1","::ffff:127.0.0.1",
  ]) assert.equal(isForbiddenIp(address), true, address);
  assert.equal(isForbiddenIp("8.8.8.8"), false);
  assert.equal(isForbiddenIp("2606:4700:4700::1111"), false);
});

test("URL validation rejects dangerous schemes, credentials, metadata and unknown domains before fetch", async () => {
  for (const raw of [
    "file:///etc/passwd","gopher://example.com/","ftp://example.com/a",
    "https://user:pass@ebay.com/","http://localhost/","http://127.0.0.1/",
    "http://[::1]/","http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/computeMetadata/v1/","https://unknown.example/product",
  ]) await assert.rejects(() => validatePublicUrl(raw));
});

test("trusted registry uses exact domain boundaries and admin extensions are validated", () => {
  assert.equal(isTrustedDomain("ebay.com"), true);
  assert.equal(isTrustedDomain("www.ebay.com"), true);
  assert.equal(isTrustedDomain("ebay.com.attacker.example"), false);
  assert.equal(addTrustedDomain("partner.example"), "partner.example");
  assert.equal(isTrustedDomain("shop.partner.example"), true);
  assert.throws(() => addTrustedDomain("localhost"));
  assert.throws(() => addTrustedDomain("bad domain"));
});

test("redirect targets are revalidated and response/time limits are strict", async () => {
  await assert.rejects(() => validateRedirectTarget("http://169.254.169.254/latest", new URL("https://ebay.com/item")));
  await assert.rejects(() => validateRedirectTarget("file:///etc/passwd", new URL("https://ebay.com/item")));
  const oversized = new Response(new Uint8Array(publicFetchPolicy.maxResponseBytes + 1));
  await assert.rejects(() => readBodyLimited(oversized), /response_too_large/);
  assert.ok(publicFetchPolicy.timeoutMs <= 8_000);
  assert.ok(publicFetchPolicy.maxRedirects <= 4);
});