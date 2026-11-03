// Vocabulary maps: severity / label / status / event types / kill-chain stages / detection rules.

export const SEVERITY = Object.freeze({
  critical: {
    tone: "bad",
    ptone: "sev-critical",
    label: "Critical",
    hint: "Reached a real asset or used a honeytoken",
    rank: 4,
  },
  high: {
    tone: "drift",
    ptone: "sev-high",
    label: "High",
    hint: "Got in and executed; needs review within the hour",
    rank: 3,
  },
  medium: {
    tone: "rejected",
    ptone: "sev-medium",
    label: "Medium",
    hint: "Suspicious; batch review",
    rank: 2,
  },
  low: { tone: "halted", ptone: "sev-low", label: "Low", hint: "Low-impact decoy touch", rank: 1 },
});

export const LABEL = Object.freeze({
  targeted: {
    tone: "bad",
    label: "Targeted",
    hint: "Human-paced, cross-sensor, or reached a real asset",
  },
  opportunistic: {
    tone: "drift",
    label: "Opportunistic",
    hint: "Got in with common creds, scripted",
  },
  noise: { tone: "halted", label: "Noise", hint: "Scanners and bots; auto-suppressed" },
});

export const INCIDENT_STATUS = Object.freeze({
  open: { tone: "drift", label: "Open" },
  acknowledged: { tone: "cache", label: "Acknowledged" },
  resolved: { tone: "ok", label: "Resolved" },
  false_positive: { tone: "halted", label: "False positive" },
});

export const EVENT_LABEL = Object.freeze({
  "connection.open": "Connection opened",
  "connection.close": "Connection closed",
  "auth.attempt": "Login attempt",
  "command.exec": "Command run",
  "http.request": "Decoy page hit",
  "file.download": "Decoy data accessed",
  "file.upload": "File uploaded",
  "honeytoken.read": "Honeytoken file read",
  "honeytoken.use": "Honeytoken USED",
  "asset.access": "Real asset touched",
  "asset.blocked": "Blocked request",
  "proxy.attempt": "Tunnelling attempt",
  "ssh.client": "SSH client banner",
  "db.command": "Database command",
  "prod.firewall": "Firewall log",
  "prod.auth": "Auth log",
});

// Tone for the dot next to a raw event
export function eventTone(e) {
  const t = e.event_type;
  if (t === "honeytoken.use" || t === "asset.access") return "bad";
  if (t === "honeytoken.read" || t === "file.download" || t === "file.upload") return "drift";
  if (t === "command.exec" || (t === "auth.attempt" && e.outcome === "success")) return "drift";
  if (t === "asset.blocked" || t === "proxy.attempt") return "rejected";
  return "halted";
}

export const STAGES = [
  "recon",
  "initial_access",
  "execution",
  "discovery",
  "collection",
  "exfiltration",
];
export const STAGE_LABEL = Object.freeze({
  recon: "Recon",
  initial_access: "Initial Access",
  execution: "Execution",
  discovery: "Discovery",
  collection: "Collection",
  exfiltration: "Exfiltration",
});

export const SENSOR_LABEL = Object.freeze({
  web: "Web decoy",
  ssh: "SSH decoy",
  redis: "Redis decoy",
  sdk: "App SDK",
  prod: "Prod telemetry",
});

// Rule catalogue (docs/05 rule table). describeRule(id) returns a human sentence.
export const RULES = Object.freeze({
  R01: {
    name: "Decoy touched",
    sentence: "Touched a decoy (path or port) that no legitimate user has a reason to visit.",
  },
  R02: {
    name: "Sweep",
    sentence:
      "Probed three or more distinct decoys or paths within 60 seconds, a sweep rather than a visit.",
  },
  R03: {
    name: "Known scanner",
    sentence:
      "Presented a user-agent or SSH client banner belonging to a known scanner (nmap, masscan, zgrab, sqlmap, nikto, hydra).",
  },
  R04: {
    name: "Brute force",
    sentence: "Five or more failed logins within 60 seconds: password guessing.",
  },
  R05: {
    name: "Exploit attempt",
    sentence: "Sent a SQL injection, XSS, traversal or command-injection signature to a decoy.",
  },
  R06: {
    name: "Default credentials",
    sentence: "Successfully logged in to a decoy with a default or weak credential.",
  },
  R07: {
    name: "Interactive session",
    sentence: "Ran three or more commands in one session: a person or script is inside the decoy.",
  },
  R08: {
    name: "Discovery commands",
    sentence: "Ran reconnaissance commands (ls, uname, whoami, id, ps) to map the host.",
  },
  R09: {
    name: "Tool transfer",
    sentence: "Tried to pull tooling onto the host with wget, curl, tftp or an SCP upload.",
  },
  R10: {
    name: "Persistence attempt",
    sentence:
      "Tried to persist via crontab, authorized_keys or Redis CONFIG SET / REPLICAOF / MODULE LOAD.",
  },
  R11: {
    name: "Decoy data accessed",
    sentence:
      "Opened bait data (customer_data.csv, backup.sql, panel export) or read a honeytoken file.",
  },
  R12: {
    name: "Multi-decoy spread",
    sentence: "Same source touched two or more decoy types. Label signal only, adds no points.",
  },
  R13: {
    name: "Human cadence",
    sentence:
      "Typing rhythm shows a human: three or more actions with variable gaps over 1.5 s. Label signal, adds no points.",
  },
  R14: {
    name: "Revisit",
    sentence: "Came back after more than 10 minutes idle: persistent, not a drive-by.",
  },
  R15: {
    name: "Real asset reached",
    sentence:
      "A source we were already watching touched a real production asset. Points depend on how targeted it already looked.",
  },
  R16: {
    name: "Honeytoken used",
    sentence:
      "A honeytoken planted in a decoy was used against the real application. Zero false positives; forces Critical and Targeted.",
  },
  R17: {
    name: "Evasion",
    sentence: "Tried to hide its tracks: history -c, deleted logs or unset HISTFILE.",
  },
  R18: {
    name: "Exfiltration",
    sentence:
      "Decoy data left the decoy (bait file served or panel export downloaded). Tag only, adds no points.",
  },
  R19: {
    name: "Tunnelling",
    sentence: "Requested SSH port-forwarding to pivot through the decoy.",
  },
});

export function describeRule(id) {
  return RULES[id]?.sentence || `Detection rule ${id}`;
}
export function ruleName(id) {
  return RULES[id]?.name || id;
}
