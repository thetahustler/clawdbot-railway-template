# Stock-defaults hygiene (LIVE Railway)

Operator playbook for James Putra’s **existing** OpenClaw service on Railway.

This is **not** a platform move, image hop, or template rewrite. It is a
reviewable, reversible hygiene pass against the live volume after the
`v2026.7.1-2` pin.

**This Cloud Agent must not SSH to Railway or mutate production.** Another
operator (New Bot / James) runs the live steps below.

Related: [thetahustler/openclaw-backups#1](https://github.com/thetahustler/openclaw-backups/issues/1).

| Item | Value |
| --- | --- |
| Live pin | OpenClaw `v2026.7.1-2` (`Dockerfile` `OPENCLAW_GIT_REF`) |
| State dir | `/data/.openclaw` (`OPENCLAW_STATE_DIR`) |
| Workspace | `/data/workspace` (`OPENCLAW_WORKSPACE_DIR`) |
| Config | `/data/.openclaw/openclaw.json` (JSON5; treat as the source of truth) |
| CLI on box | `openclaw` → `node /openclaw/dist/entry.js` |
| Wrapper /setup console | **Read-mostly.** It can `config get` / `doctor` / gateway restart. It cannot `config set`, `secrets apply`, or `cron edit`. Mutations need a container shell. |

## Goals (approved)

1. **Telegram stock defaults:** set `channels.telegram.defaultAccount=default`. Prune
   **root** `botToken` / `groups` only when they are exact duplicates of the
   same fields under `channels.telegram.accounts.*`.
2. **SecretRefs:** convert `${ENV}` / `$ENV` shorthand (and any leftover
   plaintext) on supported credential paths into structured env SecretRefs.
   Scrub the journal agent’s generated `models.json` raw `anthropic-pj` key so
   it is env-backed (`PJ_ANTHROPIC_API_KEY`), not a disk residue.
3. **Cron `agent_id`:** persist a real agent id on jobs that still store
   `NULL` / empty `agent_id` (legacy `jobs.json` → SQLite residue). Do not
   guess `main` for every row.

Doctor / `secrets audit` treat `${ANTHROPIC_API_KEY}`-style strings as
shorthand, not as SecretRef objects. Runtime can resolve the shorthand.
Hygiene is complete only when `openclaw secrets audit --check` is clean and
the fields are objects of the form
`{"source":"env","provider":"default","id":"ENV_NAME"}`.

## Non-goals / do-not-touch

- Do **not** change Railway project/service/volume/domain settings.
- Do **not** bump `OPENCLAW_GIT_REF` or redeploy a different image for this
  pass.
- Do **not** drop these **Dockerfile patches** (they stay in this repo):
  - extension `package.json` `openclaw` range / `workspace:*` relax
  - `pnpm_config_minimumReleaseAge=0` and the matching
    `pnpm-workspace.yaml` `minimumReleaseAge` sed
- Do **not** remove, rename, or disable **`gmail_agent`** (live agent /
  workspace skill). Confirm it still exists after every write.
- Do **not** run `openclaw doctor --fix --force` or a blanket
  `doctor --fix` as a substitute for the targeted steps below.
- Do **not** print, log, commit, or paste secret **values**. Env **names**
  and SecretRef **ids** are fine.

## Known Railway variable names (no values)

These names already exist (or should exist) as Railway service variables.
They are the only `ref.id` values this playbook maps. Confirm each is
present and non-empty **by name** before applying SecretRefs:

| Railway name | Typical live target (confirm on box) |
| --- | --- |
| `OPENCLAW_GATEWAY_TOKEN` | `gateway.auth.token` (and `gateway.remote.token` only if that field is already set) |
| `ANTHROPIC_API_KEY` | `models.providers.<id>.apiKey` for the primary Anthropic provider |
| `ANTHROPIC_API_KEY_AR` | `models.providers.<id>.apiKey` for the AR / named Anthropic provider |
| `MIAMI_HONORARY_ANTHROPIC_API_KEY` | Miami Honorary agent / provider `apiKey` |
| `PJ_ANTHROPIC_API_KEY` | Journal / `anthropic-pj` provider `apiKey` |
| `TELEGRAM_BOT_TOKEN` | `channels.telegram.accounts.default.botToken` |
| `MIAMI_HONORARY_TELEGRAM_BOT_TOKEN` | Miami Honorary Telegram `accounts.*.botToken` |
| `PUTRA_JOURNAL_TELEGRAM_BOT` | Journal Telegram `accounts.*.botToken` |

Do not invent account or provider ids. Copy them from the inventory step.

Plan template (no secret values):
[`templates/secrets-apply-plan.env-secretrefs.json`](./templates/secrets-apply-plan.env-secretrefs.json).

## Safety model

1. Backup first. `secrets apply` does **not** write a plaintext rollback
   copy of old values.
2. Inventory with redacted / shape-only commands.
3. Dry-run every write (`--dry-run` on `config set` / `config unset` /
   `config patch` / `secrets apply` / `cron edit` when available).
4. Apply one goal at a time. Re-inventory. Keep `gmail_agent`.
5. Reload or restart the **wrapper-managed** gateway (do not spawn a
   second gateway).
6. Stop and restore from backup if anything unexpected appears.

`--dry-run` on `openclaw config set` in `v2026.7.1-2` is **dry-run only**.
`--allow-exec` is not needed for env SecretRefs and must not be used here.

---

## 0. Operator access (human only)

Copy the SSH command from the Railway dashboard (service → Copy SSH
Command) or:

```bash
railway ssh --project <project> --environment <environment> --service <service>
```

Confirm you are on the live box before editing:

```bash
openclaw --version
# expect a 2026.7.1-2 build (wrapper /setup status also shows the pin)

echo "STATE=$OPENCLAW_STATE_DIR WORKSPACE=$OPENCLAW_WORKSPACE_DIR"
# expect /data/.openclaw and /data/workspace

openclaw config file
# expect /data/.openclaw/openclaw.json (regular file, not a symlink)

test -d /data/workspace && test -f /data/.openclaw/openclaw.json && echo ok
```

If `openclaw --version` is not `v2026.7.1-2`, **stop**. This playbook is
pinned to that CLI contract (`openclaw cron`, not `openclaw automations`).

The image does **not** ship `jq`. Use `openclaw config get --json`
(redacted snapshot) or the `node` inspectors below. If you use `jq` on a
**local backup copy**, never print secret-shaped strings.

---

## 1. Backup (mandatory, before any write)

Take two copies: a wrapper export (easy restore) and on-volume snapshots
(fast rollback without re-importing the whole tree).

### 1a. Wrapper export

While authenticated to `/setup`, download:

`GET /setup/export` → `openclaw-backup-<timestamp>.tar.gz`

This archive includes `/data/.openclaw` and `/data/workspace` (dotfiles
included). Store it in the private backups repo / issue #1 — **not** in
this template repo.

### 1b. On-volume snapshots

In the container:

```bash
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAP="/data/.openclaw/hygiene-backup-$STAMP"
mkdir -p "$SNAP"
chmod 700 "$SNAP"

cp -a /data/.openclaw/openclaw.json "$SNAP/openclaw.json"
# keep a second copy next to the live file (wrapper-style)
cp -a /data/.openclaw/openclaw.json "/data/.openclaw/openclaw.json.bak-$STAMP"

# SQLite cron / auth store (name can vary; copy every *.sqlite*)
find /data/.openclaw -maxdepth 3 \( -name '*.sqlite' -o -name '*.sqlite-wal' -o -name '*.sqlite-shm' \) \
  -exec cp -a {} "$SNAP/" \;

# Generated model catalogs (journal residue lives here)
if [ -d /data/.openclaw/agents ]; then
  mkdir -p "$SNAP/agents"
  find /data/.openclaw/agents -name models.json -exec cp -a --parents {} "$SNAP/" \;
fi

# Auth residues if present
for f in auth-profiles.json auth.json .env; do
  [ -f "/data/.openclaw/$f" ] && cp -a "/data/.openclaw/$f" "$SNAP/"
done

ls -la "$SNAP"
echo "SNAP=$SNAP"
```

Record `SNAP=` in the backups issue. Do not `cat` these files in chat.

If Railway volume download is used instead, pull the snapshot directory
only after it exists. Treat the tarball as secret material.

---

## 2. Inventory (read-only)

Prefer CLI getters. `config get` reads the **redacted** snapshot — secrets
should print as `__OPENCLAW_REDACTED__` or as SecretRef / `${ENV}` shapes,
never as raw tokens. If a command ever prints a token-shaped value, stop
and rotate that credential after rollback.

### 2a. Shape-only inspector (no secret values)

```bash
node <<'NODE'
const { spawnSync } = require("node:child_process");
function claw(args) {
  const r = spawnSync("openclaw", args, { encoding: "utf8" });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout || `exit ${r.status}\n`);
    process.exit(r.status || 1);
  }
  return r.stdout;
}
function parse(args) {
  const raw = claw(args);
  try { return JSON.parse(raw); } catch {
    return { _unparsed: true, _bytes: raw.length };
  }
}
function kind(v) {
  if (v == null) return "absent";
  if (typeof v === "object") {
    if (v.source && v.id) return `secretref:${v.source}:${v.provider || "default"}:${v.id}`;
    if (v === "__OPENCLAW_REDACTED__") return "redacted";
    return `object:keys=${Object.keys(v).sort().join(",")}`;
  }
  if (typeof v === "string") {
    if (v === "__OPENCLAW_REDACTED__") return "redacted";
    const m = v.match(/^\$\{([A-Z][A-Z0-9_]{0,127})\}$/) || v.match(/^\$([A-Z][A-Z0-9_]{0,127})$/);
    if (m) return `env-shorthand:${m[1]}`;
    if (/^\d{5,}:[A-Za-z0-9_-]{10,}$/.test(v) || /^sk-ant-/i.test(v)) return "PLAINTEXT_LOOKS_LIKE_SECRET";
    return `string:len=${v.length}`;
  }
  return typeof v;
}
const tg = parse(["config", "get", "channels.telegram", "--json"]);
const accounts = tg.accounts && typeof tg.accounts === "object" ? tg.accounts : {};
const accountReport = Object.fromEntries(Object.entries(accounts).map(([id, a]) => [id, {
  enabled: a && a.enabled,
  botToken: kind(a && a.botToken),
  hasGroups: Boolean(a && a.groups && Object.keys(a.groups).length),
  groupIds: a && a.groups ? Object.keys(a.groups) : [],
}]));
const rootGroups = tg.groups && typeof tg.groups === "object" ? Object.keys(tg.groups) : [];
const dupGroups = {};
for (const [id, a] of Object.entries(accounts)) {
  const g = a && a.groups && typeof a.groups === "object" ? Object.keys(a.groups) : [];
  dupGroups[id] = rootGroups.length > 0 && g.length > 0 &&
    rootGroups.length === g.length && rootGroups.every((k) => g.includes(k));
}
const providers = parse(["config", "get", "models.providers", "--json"]) || {};
const providerReport = Object.fromEntries(Object.entries(providers).map(([id, p]) => [id, {
  apiKey: kind(p && p.apiKey),
  modelCount: Array.isArray(p && p.models) ? p.models.length : 0,
}]));
const agents = parse(["config", "get", "agents", "--json"]);
const gatewayAuth = parse(["config", "get", "gateway.auth", "--json"]);
const gatewayRemote = parse(["config", "get", "gateway.remote", "--json"]);
console.log(JSON.stringify({
  defaultAccount: tg.defaultAccount ?? null,
  root: {
    enabled: tg.enabled,
    botToken: kind(tg.botToken),
    groupIds: rootGroups,
  },
  accounts: accountReport,
  rootGroupsDuplicatedUnderAccount: dupGroups,
  gatewayAuthToken: kind(gatewayAuth && gatewayAuth.token),
  gatewayRemoteToken: kind(gatewayRemote && gatewayRemote.token),
  providers: providerReport,
  agentIds: agents && agents.entries ? Object.keys(agents.entries) : agents,
  gmailAgentPresent: Boolean(
    (agents && agents.entries && (agents.entries.gmail_agent || agents.entries.gmailAgent)) ||
    (Array.isArray(agents && agents.list) && agents.list.some((a) => a && (a.id === "gmail_agent" || a.id === "gmailAgent")))
  ),
}, null, 2));
NODE
```

**Pass criteria for this inspector**

- `gmailAgentPresent` is `true`. If false, **stop** and do not continue.
- Telegram account ids are recorded (you need them for the plan).
- `root.botToken` is `absent`, `env-shorthand:*`, `secretref:*`, or
  `redacted`. If `PLAINTEXT_LOOKS_LIKE_SECRET`, treat goal 2 as urgent and
  do not paste the inspector output into a ticket.
- `rootGroupsDuplicatedUnderAccount.default === true` is the only case
  where root `groups` may be pruned. If root groups exist and are **not**
  a key-for-key duplicate of some `accounts.*` map, **keep the root map**.

### 2b. Doctor + secrets audit (read-only)

```bash
openclaw doctor
openclaw secrets audit --json
openclaw secrets audit --check; echo "audit_exit=$?"
# 0 = clean, 1 = findings, 2 = unresolved refs
```

Record finding **codes and paths** only (`PLAINTEXT_FOUND`,
`REF_UNRESOLVED`, `REF_SHADOWED`, `LEGACY_RESIDUE`). Do not dump values.

Expected gap before hygiene: many `${ENV}` fields + doctor asking for
real SecretRef objects; journal `agents/*/agent/models.json` may still
hold a raw `anthropic-pj` key.

### 2c. Env names present (values never printed)

```bash
node <<'NODE'
const names = [
  "OPENCLAW_GATEWAY_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_AR",
  "MIAMI_HONORARY_ANTHROPIC_API_KEY",
  "PJ_ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "MIAMI_HONORARY_TELEGRAM_BOT_TOKEN",
  "PUTRA_JOURNAL_TELEGRAM_BOT",
];
for (const n of names) {
  const v = process.env[n];
  const ok = Boolean(v && String(v).trim());
  console.log(`${n}=${ok ? "set:len=" + String(v).trim().length : "MISSING"}`);
}
NODE
```

A SecretRef whose `id` is `MISSING` will fail activation on an **active**
surface. Fix Railway Variables first; do not apply the plan.

### 2d. Cron jobs with missing `agent_id`

```bash
openclaw cron list --json > /tmp/cron-list.json
node <<'NODE'
const fs = require("node:fs");
const raw = JSON.parse(fs.readFileSync("/tmp/cron-list.json", "utf8"));
const jobs = raw.jobs || raw.items || (Array.isArray(raw) ? raw : []);
const rows = jobs.map((j) => ({
  id: j.id || j.jobId,
  name: j.name,
  enabled: j.enabled,
  agentId: j.agentId ?? j.agent_id ?? null,
  missingAgent: j.agentId == null || j.agentId === "" || j.agent_id == null || j.agent_id === "",
  schedule: j.scheduleKind || (j.schedule && j.schedule.kind) || null,
}));
console.log(JSON.stringify({
  total: rows.length,
  missingAgent: rows.filter((r) => r.missingAgent).length,
  jobs: rows,
}, null, 2));
NODE
```

`cron list` may **display** a missing agent as the configured default
agent. Hygiene still requires a stored id. Do not assign every NULL row
to `main` — match each job to the agent that already owns that work
(journal jobs → journal agent, Miami Honorary jobs → that agent, etc.).

### 2e. Fill the secrets plan

Copy
[`templates/secrets-apply-plan.env-secretrefs.json`](./templates/secrets-apply-plan.env-secretrefs.json)
to `/tmp/openclaw-secrets-plan.json` **on the box**.

Replace every `REPLACE_ME_*` path / `providerId` / `accountId` with ids
from §2a. Delete targets that do not exist on live. Do not add exec/file
providers. Do not put secret values in the file.

`target.type` must match the `v2026.7.1-2` registry (apply rejects
unknown types before any write):

| Field | `target.type` |
| --- | --- |
| Gateway token | `gateway.auth.token` |
| Provider API keys | `models.providers.apiKey` (alias `models.providers.*.apiKey`) |
| Per-account Telegram tokens | `channels.telegram.accounts.*.botToken` |
| Root Telegram token (only if you keep it) | `channels.telegram.botToken` |

A plan that still contains `REPLACE_ME_*` **must fail** dry-run. That is
intentional — do not apply the stock file as-is.

Validate JSON:

```bash
node -e 'JSON.parse(require("fs").readFileSync("/tmp/openclaw-secrets-plan.json","utf8")); console.log("plan json ok")'
```

---

## 3. Goal 1 — Telegram `defaultAccount` + prune duplicates

### 3a. Set the explicit default

```bash
openclaw config set channels.telegram.defaultAccount default --dry-run --json
openclaw config set channels.telegram.defaultAccount default
openclaw config get channels.telegram.defaultAccount
# expect: default
```

If inventory shows there is **no** `accounts.default` key, **stop**.
Creating a new account id is out of scope. Either the live default
account id is already `default`, or James must confirm a different
`defaultAccount` value. Do not invent one.

### 3b. Prune root `botToken` only if duplicated

Root `botToken` is redundant when `accounts.default.botToken` (or the
account named by `defaultAccount`) already carries the same credential
shape / same env id.

```bash
# Inspect shapes only (from §2a). If root.botToken is absent, skip.
# If accounts.default.botToken is absent, do NOT unset root.

openclaw config unset channels.telegram.botToken --dry-run --json
# review: must not remove accounts.*.botToken

openclaw config unset channels.telegram.botToken
```

If root and account tokens are **different** env ids, keep both and
escalate — that is not “redundant.”

### 3c. Prune root `groups` only if duplicated

Only when §2a `rootGroupsDuplicatedUnderAccount.<id>` is `true` for the
account that should own those groups (normally `default`):

```bash
openclaw config unset channels.telegram.groups --dry-run --json
openclaw config unset channels.telegram.groups
```

If any group id exists only at the root, **keep the root map**. Named
accounts do **not** inherit `accounts.default.groups`; they inherit the
**root** `groups` when the account-level map is unset. Pruning a
non-duplicate root map will silently drop group allowlists.

### 3d. Re-check

```bash
# Re-run the §2a inspector. Expect:
# defaultAccount=default
# root.botToken=absent (only if you pruned)
# accounts.default.botToken still present
# gmailAgentPresent=true
openclaw config validate --json
```

---

## 4. Goal 2 — SecretRefs + journal `models.json` scrub

Preferred path on `v2026.7.1-2`: a saved plan + `secrets apply`.
`openclaw config set --ref-source env ...` is the fallback for a single
path.

### 4a. Dry-run the plan

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run --json
```

Dry-run must report `ok` (or the CLI equivalent) with **no**
`resolvability` errors. If a ref id is missing from the process
environment, add the Railway variable and restart the **deployment**
(env injection) before write-mode apply. That restart is an operator
Railway action, not an image change.

Do **not** pass `--allow-exec`.

### 4b. Apply

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --json
```

Apply is one-way for scrubbed plaintext. Restore from §1 if it goes
wrong.

### 4c. Single-path fallback (if apply rejects one target)

```bash
# example — use the live path from inventory
openclaw config set channels.telegram.accounts.default.botToken \
  --ref-source env --ref-provider default --ref-id TELEGRAM_BOT_TOKEN \
  --dry-run --json

openclaw config set channels.telegram.accounts.default.botToken \
  --ref-source env --ref-provider default --ref-id TELEGRAM_BOT_TOKEN
```

Same pattern for each remaining `${ENV}` / plaintext supported path.

### 4d. Journal `models.json` residue

`secrets apply` rewrites `openclaw.json` (and auth/.env residues).
Generated `agents/*/agent/models.json` is rewritten on the next
successful secrets activation when the **source** provider `apiKey` is a
SecretRef. After apply:

```bash
openclaw secrets reload --json
# if reload cannot reach the wrapper-managed gateway:
# use /setup console → gateway.restart  (or restartGateway via wrapper)
```

Then:

```bash
openclaw secrets audit --check; echo "audit_exit=$?"
```

If audit still reports `PLAINTEXT_FOUND` on a journal `models.json`
`anthropic-pj` / `apiKey` path:

1. Confirm the live provider path used by the journal agent is a
   SecretRef to `PJ_ANTHROPIC_API_KEY` (`config get` shape only).
2. Restart the wrapper-managed gateway once more so catalogs regenerate.
3. Re-audit.

Do **not** hand-edit `models.json` to insert another raw key. Do **not**
`cat` the file. If you must confirm residue is gone, use:

```bash
node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.OPENCLAW_STATE_DIR || "/data/.openclaw";
function walk(d, acc = []) {
  if (!fs.existsSync(d)) return acc;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name === "models.json") acc.push(p);
  }
  return acc;
}
for (const p of walk(path.join(root, "agents"))) {
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const keys = [];
  const visit = (o, prefix) => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      const pathk = prefix ? `${prefix}.${k}` : k;
      if (k === "apiKey" || /authorization|x-api-key|token|secret|password|credential/i.test(k)) {
        const shape = (v && typeof v === "object" && v.source && v.id)
          ? `secretref:${v.id}`
          : (typeof v === "string" && (/^\$\{?[A-Z][A-Z0-9_]*\}?$/.test(v) || /^oc-sent-v1-/.test(v) || v.includes("env:")))
            ? `marker:${String(v).slice(0, 48)}`
            : (typeof v === "string" && v.length > 0 ? "NON_MARKER_STRING" : typeof v);
        keys.push({ path: pathk, shape });
      }
      if (v && typeof v === "object") visit(v, pathk);
    }
  };
  visit(j, "");
  console.log(JSON.stringify({ file: p.replace(root, "$STATE"), keys }, null, 2));
}
NODE
```

`NON_MARKER_STRING` means residue remains. `secretref:*`, `marker:*`, or
empty `keys` is the pass.

### 4e. Re-check

```bash
openclaw secrets audit --check; echo "audit_exit=$?"
openclaw config validate --json
# Re-run §2a inspector — gmailAgentPresent must still be true
```

---

## 5. Goal 3 — Cron `agent_id`

Prefer the CLI. Do **not** start with `UPDATE cron_jobs`.

### 5a. Map each NULL job

From §2d, write a table (ids only) before editing:

| job id | name | assigned agent id | why |
| --- | --- | --- | --- |
| … | … | `gmail_agent` / journal / main / … | existing session, delivery target, or owner |

If you cannot name the owner, leave the job untouched and escalate.

### 5b. Persist via CLI

```bash
openclaw cron edit <job-id> --agent <agentId>
openclaw cron get <job-id>
# confirm agentId is the string you set
```

Repeat per NULL job. Do not use `--clear-agent`.

`v2026.7.1-2` `cron list` treats a missing stored id as the configured
default for **display**. After edit, `cron get` must show a concrete
`agentId`.

### 5c. SQL last resort (only if CLI cannot persist)

Only after §1 snapshots, and only if `cron edit --agent` succeeds in the
CLI response but `cron get` still shows a null id (or the CLI rejects
the edit). Use Python so you never print other columns.

```bash
# Discover the DB file from the snapshot / find, not from memory.
# Typical: /data/.openclaw/*.sqlite or a state/ subdir.
DB="$(find /data/.openclaw -name '*.sqlite' | head -n 1)"
echo "DB=$DB"
python3 - <<'PY'
import os, sqlite3
db = os.environ.get("DB") or ""
# operator: export DB=/path before running, or edit this line
if not db:
    raise SystemExit("set DB to the sqlite path")
con = sqlite3.connect(db)
cur = con.cursor()
tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")]
print("tables", tables)
if "cron_jobs" not in tables:
    raise SystemExit("no cron_jobs table")
cols = [r[1] for r in cur.execute("PRAGMA table_info(cron_jobs)")]
print("cron_jobs columns", cols)
rows = cur.execute(
    "SELECT id, name, agent_id FROM cron_jobs WHERE agent_id IS NULL OR agent_id = ''"
).fetchall()
print("null_agent_rows", [(r[0], r[1], r[2]) for r in rows])
con.close()
PY
```

Then update **one id at a time**:

```bash
export DB=... JOB_ID=... AGENT_ID=...
python3 - <<'PY'
import os, sqlite3
con = sqlite3.connect(os.environ["DB"])
cur = con.cursor()
cur.execute(
    "UPDATE cron_jobs SET agent_id = ? WHERE id = ? AND (agent_id IS NULL OR agent_id = '')",
    (os.environ["AGENT_ID"], os.environ["JOB_ID"]),
)
print("rows_updated", cur.rowcount)
con.commit()
con.close()
PY
openclaw cron get "$JOB_ID"
```

Never `UPDATE cron_jobs SET agent_id = 'main' WHERE agent_id IS NULL`.

### 5d. Re-check

```bash
# Re-run §2d inspector. missingAgent must be 0 for jobs you intended to fix.
openclaw cron list --json | node -e '
let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
  const raw=JSON.parse(s); const jobs=raw.jobs||raw.items||[];
  const missing=jobs.filter(j => j.agentId==null || j.agentId==="" || j.agent_id==null || j.agent_id==="");
  console.log(JSON.stringify({total:jobs.length, missing:missing.map(j=>j.id||j.jobId)}));
});
'
```

---

## 6. Activate runtime (after writes)

```bash
openclaw secrets reload --json
openclaw config validate --json
```

If the gateway still holds a last-known-good snapshot (reload error /
`SECRETS_RELOADER_DEGRADED`):

1. Do **not** keep applying more writes.
2. Use `/setup` console `gateway.restart` (wrapper-managed).
3. If the gateway will not become ready, roll back (§7).

Wrapper `/healthz` and `/setup/api/debug` (authenticated) should show the
gateway running. Do not paste debug blobs that include channel tokens.

---

## 7. Rollback

| What failed | Restore |
| --- | --- |
| Config / SecretRef apply | `cp -a $SNAP/openclaw.json /data/.openclaw/openclaw.json` then wrapper `gateway.restart` |
| Auth / `.env` scrub | copy those files back from `$SNAP` if they were snapshotted |
| Generated `models.json` | copy the snapshotted `agents/**/models.json` back, **or** restore `openclaw.json` and restart so catalogs regenerate |
| Cron CLI / SQL | restore every `*.sqlite*` from `$SNAP` into the same relative paths, then `gateway.restart` |
| Unsure / multiple files | `/setup` **Import backup** of the §1a tarball (overwrites under `/data`, then restarts). Import does **not** delete extra files that did not exist in the archive. |

Verify after restore:

```bash
openclaw config get channels.telegram.defaultAccount
# Re-run §2a inspector — gmailAgentPresent=true
openclaw secrets audit --check; echo "audit_exit=$?"
openclaw cron list --json >/dev/null
```

`secrets apply` will not un-scrub plaintext. The snapshot / tarball is
the only rollback for values.

---

## 8. Telegram smoke matrix (another operator)

Do **not** skip this. Run after hygiene (or after rollback) on **live**.
This agent does not send Telegram traffic.

Test **DMs and @mention groups** for every enabled Telegram account that
inventory listed. At minimum:

| # | Account (live id) | Surface | Action | Pass |
| --- | --- | --- | --- | --- |
| 1 | `default` | DM | Send a short ping; bot replies once | |
| 2 | `default` | Known group (e.g. main) | `@mention` the bot; single reply, no duplicate | |
| 3 | `default` | Praha group (if still enabled) | `@mention`; single reply | |
| 4 | Miami Honorary account | DM | Ping | |
| 5 | Miami Honorary account | Its @mention group(s) | `@mention` | |
| 6 | Journal / Putra Journal account | DM | Ping | |
| 7 | Journal account | Its @mention group(s) | `@mention` | |
| 8 | Any group that should **ignore** the bot | Message **without** @mention | No reply | |
| 9 | After a wrapper `gateway.restart` | Repeat #1 and one @mention | Still healthy | |

Also confirm **`gmail_agent`** still appears in `openclaw config get agents`
and that a known gmail-agent path (inbox skill / cron, if you use one)
was not deleted.

**Fail** if: 401 / pairing loop / duplicate delivery / wrong account
answers a mention / gateway not ready / `gmail_agent` missing.

On fail: stop, roll back (§7), then re-smoke #1 and one @mention before
any further hygiene.

---

## 9. Done checklist

- [ ] §1 backup tarball + `$SNAP` recorded in backups issue #1
- [ ] `channels.telegram.defaultAccount` is `default`
- [ ] Root `botToken` / `groups` pruned **only** when duplicated
- [ ] Supported `${ENV}` / plaintext credential paths are SecretRef objects
- [ ] `openclaw secrets audit --check` exits `0` (or remaining findings are
      listed and accepted in the issue)
- [ ] Journal `models.json` has no `NON_MARKER_STRING` apiKey residue
- [ ] Cron jobs that were NULL now have a stored `agentId` you can justify
- [ ] `gmail_agent` still present
- [ ] Dockerfile patches / `v2026.7.1-2` pin untouched
- [ ] Telegram smoke matrix completed by a human operator
- [ ] No secret values written to git, tickets, or chat

---

## Command cheat-sheet (`v2026.7.1-2`)

```bash
openclaw config file
openclaw config get <path> --json          # redacted snapshot
openclaw config set <path> <value> --dry-run --json
openclaw config set <path> --ref-source env --ref-provider default --ref-id ENV_NAME --dry-run --json
openclaw config unset <path> --dry-run --json
openclaw config validate --json

openclaw secrets audit --json
openclaw secrets audit --check
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run --json
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --json
openclaw secrets reload --json

openclaw cron list --json
openclaw cron get <job-id>
openclaw cron edit <job-id> --agent <agentId>

openclaw doctor                            # inspect only
```

Upstream references (same pin’s docs):

- [Secrets management](https://docs.openclaw.ai/gateway/secrets)
- [Secrets apply plan contract](https://docs.openclaw.ai/gateway/secrets-plan-contract)
- [SecretRef credential surface](https://docs.openclaw.ai/reference/secretref-credential-surface)
- [Config CLI](https://docs.openclaw.ai/cli/config)
- [Cron CLI](https://docs.openclaw.ai/cli/cron)
