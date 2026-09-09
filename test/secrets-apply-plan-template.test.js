import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const KNOWN_RAILWAY_ENV = new Set([
  "OPENCLAW_GATEWAY_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_AR",
  "MIAMI_HONORARY_ANTHROPIC_API_KEY",
  "PJ_ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "MIAMI_HONORARY_TELEGRAM_BOT_TOKEN",
  "PUTRA_JOURNAL_TELEGRAM_BOT",
]);

const ALLOWED_TARGET_TYPES = new Set([
  "gateway.auth.token",
  "models.providers.apiKey",
  "models.providers.*.apiKey",
  "channels.telegram.accounts.*.botToken",
  "channels.telegram.botToken",
]);

const PLAN_URL = new URL("../docs/ops/templates/secrets-apply-plan.env-secretrefs.json", import.meta.url);

function walk(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      visit(k, v);
      walk(v, visit);
    }
  }
}

test("secrets apply plan template is valid JSON with env SecretRefs only", () => {
  const raw = fs.readFileSync(PLAN_URL, "utf8");
  assert.doesNotThrow(() => JSON.parse(raw));
  const plan = JSON.parse(raw);

  assert.equal(plan.version, 1);
  assert.equal(plan.protocolVersion, 1);
  assert.equal(plan.providerUpserts?.default?.source, "env");
  assert.equal(plan.options?.scrubEnv, true);
  assert.ok(Array.isArray(plan.targets));
  assert.ok(plan.targets.length > 0);

  const ids = [];
  for (const t of plan.targets) {
    assert.ok(ALLOWED_TARGET_TYPES.has(t.type), `unexpected target.type: ${t.type}`);
    assert.equal(t.ref?.source, "env");
    assert.equal(t.ref?.provider, "default");
    assert.match(t.ref?.id ?? "", /^[A-Z][A-Z0-9_]{0,127}$/);
    assert.ok(KNOWN_RAILWAY_ENV.has(t.ref.id), `unknown Railway env id: ${t.ref.id}`);
    ids.push(t.ref.id);
    if (t.providerId) {
      assert.equal(t.path, `models.providers.${t.providerId}.apiKey`);
    }
    if (t.accountId) {
      assert.equal(t.path, `channels.telegram.accounts.${t.accountId}.botToken`);
    }
  }

  assert.deepEqual(new Set(ids), KNOWN_RAILWAY_ENV);

  walk(plan, (_k, v) => {
    if (typeof v !== "string") return;
    assert.doesNotMatch(v, /^\d{5,}:[A-Za-z0-9_-]{10,}$/);
    assert.doesNotMatch(v, /^sk-ant-/i);
    assert.doesNotMatch(v, /^sk-[A-Za-z0-9_-]{10,}$/);
  });
});

test("secrets apply plan template is not live-ready until REPLACE_ME ids are filled", () => {
  const plan = JSON.parse(fs.readFileSync(PLAN_URL, "utf8"));
  const blob = JSON.stringify(plan);
  assert.match(blob, /REPLACE_ME_/);
});
