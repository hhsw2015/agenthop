/** Secret-redaction pure leaf (D-multica ② absorption). A zero-dependency pure function that masks high-confidence secret tokens
 *  in human-facing / transport text BEFORE it leaves this process (persist-to-disk or forward-to-peer). Every rule is anchored on
 *  a DISTINCTIVE prefix or structure (PEM header, AKIA, ghp_, sk-, xox…, or an explicit `aws_secret_access_key` key name), so a
 *  high-entropy but NON-secret string — a 40-hex git SHA, a long hex constant, a base64 body, a UUID — is never false-redacted.
 *  Rules run in priority order (first rule wins a position); the inbox `sanitizeForTransport` calls this AFTER control-char
 *  stripping. Pure: same input → same output, no IO. */

type RedactRule = { readonly label: string; readonly re: RegExp };

/** Priority-ordered secret rules. The multi-line PEM BLOCK is first so its inner base64 is already masked before any single-token
 *  rule scans it. Prefix-anchored single tokens follow. The AWS SECRET KEY has no distinctive prefix, so it is matched ONLY via a
 *  lookbehind on its key name — a bare 40-char base64 body elsewhere in the text is therefore left untouched. Each `re` is global
 *  and stateless here (a fresh `lastIndex` per call because String.replace resets it). */
const RULES: readonly RedactRule[] = [
  { label: "PEM_PRIVATE_KEY", re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g },
  { label: "AWS_AKID", re: /\b(?:AKIA|ASIA|AROA|AIDA|AGPA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g },
  { label: "GITHUB_TOKEN", re: /\b(?:ghp|gho|ghs|ghr|ghu)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { label: "SLACK_TOKEN", re: /\bxox[baprsc]-[A-Za-z0-9-]{10,}\b/g },
  { label: "API_KEY", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
  // RS-2: the key name may be followed by `=` (env) or `:` (YAML/JSON) and the value may be bare or wrapped in single OR double
  // quotes — the opening-quote class is `['"]?` (not a locked `"?`) so `KEY='v'`, `KEY: "v"` and `KEY=v` all match.
  { label: "AWS_SECRET", re: /(?<=aws_secret_access_key['"]?\s*[:=]\s*['"]?)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/gi },
];

/** Mask every secret token in `text`, replacing each with `[REDACTED:<type>]`. Pure. Non-string / empty input returns `text`
 *  unchanged. First rule to match a position wins (rules are applied in priority order; a replacement token carries no secret
 *  prefix, so later rules never re-match it). */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { label, re } of RULES) out = out.replace(re, `[REDACTED:${label}]`);
  return out;
}
