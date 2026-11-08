import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeDomain, relativeRecordName } from "../src/domain.js";

describe("domain names", () => {
  it("normalizes a registrable name", () => {
    assert.equal(normalizeDomain(" Example.COM. "), "example.com");
  });

  it("converts unicode names to punycode", () => {
    assert.equal(normalizeDomain("münchen.de"), "xn--mnchen-3ya.de");
  });

  it("rejects urls and bare words", () => {
    assert.throws(() => normalizeDomain("https://example.com/docs"), /not a domain name/);
    assert.throws(() => normalizeDomain("example"), /not a domain name/);
  });

  it("treats the apex and a full www name as relative names", () => {
    assert.equal(relativeRecordName("example.com", "@"), "");
    assert.equal(relativeRecordName("example.com", "example.com."), "");
    assert.equal(relativeRecordName("example.com", "WWW.Example.COM"), "www");
    assert.equal(relativeRecordName("example.com", "api.west"), "api.west");
  });
});
