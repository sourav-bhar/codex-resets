#!/usr/bin/env node

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_AUTH_FILE = path.join(os.homedir(), ".codex", "auth.json");
const DEFAULT_LANGUAGE = "en";
const DEFAULT_ORIGINATOR = "Codex Desktop";
const ALLOWED_BASE_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

const HELP = `Usage: codex-resets [global options] <command>

Global options:
  --json                    Emit machine-readable JSON.
  --auth-file <path>        Codex auth file to read. Defaults to ~/.codex/auth.json.
  --base-url <url>          OpenAI backend API URL. Host must be chatgpt.com or chat.openai.com.
  --tz <iana-zone>          Display timezone. Defaults to the system timezone.
  --show-identifiers        Include account ids, credit ids, source profile ids, and local auth paths.
  -h, --help                Show this help.

Commands:
  doctor                    Verify auth file, token, and endpoint reachability.
  account current           Show the currently configured Codex account id.
  credits list [--all]      List reset credits. Defaults to available credits.
  credits summary           Summarize reset credit counts and next expiration.
  request get <path>        Read-only raw GET request using current Codex auth.
  schedule launchd-plist    Print a LaunchAgent plist for periodic checks.

Examples:
  codex-resets credits list
  codex-resets --json credits summary
  codex-resets schedule launchd-plist --interval-minutes 360
`;

class CliError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }
}

class ApiError extends CliError {
  constructor(message, status, details = {}) {
    super(message, "API_ERROR", details);
    this.status = status;
  }
}

function defaultTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function expandHome(inputPath) {
  if (!inputPath) return inputPath;
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/"))
    return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function parseArgs(argv) {
  const options = {
    json: false,
    authFile: process.env.CODEX_AUTH_FILE || DEFAULT_AUTH_FILE,
    baseUrl: process.env.CODEX_RESETS_BASE_URL || DEFAULT_BASE_URL,
    timeZone: process.env.CODEX_RESETS_TZ || defaultTimeZone(),
    showIdentifiers: false,
  };
  const args = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--auth-file") {
      i += 1;
      if (!argv[i])
        throw new CliError("--auth-file requires a path", "BAD_ARGS");
      options.authFile = expandHome(argv[i]);
    } else if (arg === "--base-url") {
      i += 1;
      if (!argv[i]) throw new CliError("--base-url requires a URL", "BAD_ARGS");
      options.baseUrl = argv[i];
    } else if (arg === "--tz") {
      i += 1;
      if (!argv[i])
        throw new CliError("--tz requires an IANA timezone", "BAD_ARGS");
      assertTimeZone(argv[i]);
      options.timeZone = argv[i];
    } else if (arg === "--show-identifiers") {
      options.showIdentifiers = true;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      args.push(arg);
    }
  }

  options.authFile = expandHome(options.authFile);
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  return { options, args };
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("Invalid base URL", "BAD_BASE_URL");
  }

  if (url.protocol !== "https:") {
    throw new CliError("Base URL must use https", "BAD_BASE_URL");
  }
  if (!ALLOWED_BASE_HOSTS.has(url.hostname)) {
    throw new CliError(
      `Base URL host is not allowed: ${url.hostname}`,
      "BAD_BASE_URL",
    );
  }
  if (url.username || url.password) {
    throw new CliError("Base URL must not include credentials", "BAD_BASE_URL");
  }

  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/backend-api";
  if (!url.pathname.endsWith("/backend-api")) {
    throw new CliError(
      "Base URL path must end with /backend-api",
      "BAD_BASE_URL",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

function assertTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new CliError(`Invalid timezone: ${timeZone}`, "BAD_TIMEZONE");
  }
}

function decodeJwt(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(
      payload.length + ((4 - (payload.length % 4)) % 4),
      "=",
    );
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function readAuth(authFile) {
  let fd;
  let raw;
  let stats;
  try {
    const openFlags =
      fs.constants.O_RDONLY |
      fs.constants.O_NONBLOCK |
      (fs.constants.O_NOFOLLOW || 0);
    fd = fs.openSync(authFile, openFlags);
    stats = fs.fstatSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close failures while reporting the original auth-file error.
      }
    }
    if (error && error.code === "ENOENT") {
      throw new CliError("Codex auth file not found", "AUTH_FILE_MISSING", {
        authFile,
      });
    }
    // Use only the syscall code, never error.message: Node fs errors embed the
    // absolute auth path (revealing the home dir / username) in their message,
    // and that message is surfaced unredacted via errorToJson and human output.
    const accessCode = error && error.code ? error.code : "unknown error";
    throw new CliError(
      `Could not access Codex auth file (${accessCode})`,
      "AUTH_FILE_INVALID",
      { authFile },
    );
  }

  try {
    if (!stats.isFile()) {
      throw new CliError(
        "Codex auth path is not a regular file",
        "AUTH_FILE_NOT_REGULAR",
        { authFile },
      );
    }
    if (stats.size > MAX_AUTH_FILE_BYTES) {
      throw new CliError(
        `Codex auth file is larger than ${MAX_AUTH_FILE_BYTES} bytes`,
        "AUTH_FILE_TOO_LARGE",
        { authFile },
      );
    }
    raw = fs.readFileSync(fd, "utf8");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  let auth;
  try {
    auth = JSON.parse(raw);
  } catch (error) {
    throw new CliError(
      `Could not parse Codex auth file: ${error.message}`,
      "AUTH_FILE_INVALID",
      { authFile },
    );
  }

  const accessToken = auth?.tokens?.access_token;
  if (!accessToken || typeof accessToken !== "string") {
    throw new CliError(
      "Codex auth file does not contain tokens.access_token",
      "ACCESS_TOKEN_MISSING",
      { authFile },
    );
  }

  const tokenClaims = decodeJwt(accessToken);
  const idTokenClaims = decodeJwt(auth?.tokens?.id_token);
  return {
    authFile,
    accessToken,
    accountId:
      auth?.tokens?.account_id ||
      tokenClaims?.https?.account_id ||
      tokenClaims?.account_id ||
      null,
    tokenClaims,
    idTokenClaims,
    lastRefresh: auth?.last_refresh || null,
  };
}

function tokenInfo(auth) {
  const exp = auth?.tokenClaims?.exp;
  const expiresAt =
    typeof exp === "number" ? new Date(exp * 1000).toISOString() : null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    expires_at: expiresAt,
    expired: typeof exp === "number" ? exp <= nowSeconds : null,
    seconds_until_expiry: typeof exp === "number" ? exp - nowSeconds : null,
    last_refresh: auth.lastRefresh,
  };
}

function endpointPath(inputPath) {
  if (!inputPath) throw new CliError("Request path is required", "BAD_ARGS");
  if (/^https?:\/\//i.test(inputPath)) {
    throw new CliError(
      "Request path must be relative, such as /wham/rate-limit-reset-credits",
      "BAD_ARGS",
    );
  }
  return inputPath.startsWith("/") ? inputPath : `/${inputPath}`;
}

async function requestJson(auth, options, method, inputPath) {
  const pathPart = endpointPath(inputPath);
  const url = `${options.baseUrl}${pathPart}`;
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "OAI-Language": DEFAULT_LANGUAGE,
      originator: DEFAULT_ORIGINATOR,
    },
  });
  const text = await readResponseText(response);
  const body = parseMaybeJson(text);

  if (!response.ok) {
    throw new ApiError(
      `API request failed with ${response.status} ${response.statusText}`,
      response.status,
      {
        path: pathPart,
        body: redactBodyForError(body, auth.accessToken),
      },
    );
  }

  return body;
}

function parseMaybeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readResponseText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new CliError(
        `Response exceeded ${maxBytes} bytes`,
        "RESPONSE_TOO_LARGE",
      );
    }
    return text;
  }

  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new CliError(
        `Response exceeded ${maxBytes} bytes`,
        "RESPONSE_TOO_LARGE",
      );
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function redactSensitiveString(value, knownSecret = "") {
  let redacted = String(value);
  if (knownSecret) {
    redacted = redacted.split(knownSecret).join("[redacted]");
  }
  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[redacted-jwt]",
    );
}

function redactBodyForError(body, knownSecret = "") {
  if (typeof body === "string")
    return redactSensitiveString(body, knownSecret).slice(0, 500);
  if (!body || typeof body !== "object") return body;
  return JSON.parse(
    JSON.stringify(body, (key, value) => {
      if (/token|authorization|cookie|secret/i.test(key)) return "[redacted]";
      if (typeof value === "string")
        return redactSensitiveString(value, knownSecret);
      return value;
    }),
  );
}

async function fetchCredits(auth, options) {
  return requestJson(auth, options, "GET", "/wham/rate-limit-reset-credits");
}

function daysUntil(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.round((ms / 86400000) * 10) / 10;
}

function formatDate(iso, timeZone) {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

function publicCredit(credit, timeZone, options = {}) {
  const result = {
    reset_type: credit.reset_type,
    status: credit.status,
    title: credit.title,
    granted_at: credit.granted_at || null,
    expires_at: credit.expires_at || null,
    expires_local: formatDate(credit.expires_at, timeZone),
    expires_utc: formatDate(credit.expires_at, "UTC"),
    days_until_expiry: daysUntil(credit.expires_at),
  };
  if (options.showIdentifiers) {
    result.id = credit.id;
    result.source = credit.profile_user_id || null;
  }
  return result;
}

function normalizeCredits(payload, timeZone, includeAll = false, options = {}) {
  const credits = Array.isArray(payload?.credits) ? payload.credits : [];
  return credits
    .filter((credit) => includeAll || credit.status === "available")
    .map((credit) => publicCredit(credit, timeZone, options))
    .sort((a, b) => {
      if (!a.expires_at && !b.expires_at) return 0;
      if (!a.expires_at) return 1;
      if (!b.expires_at) return -1;
      return (
        new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime()
      );
    });
}

function summarizePayload(payload, timeZone, options = {}) {
  const credits = Array.isArray(payload?.credits) ? payload.credits : [];
  const countsByStatus = credits.reduce((acc, credit) => {
    const status = credit.status || "unknown";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const available = normalizeCredits(payload, timeZone, false, options);
  return {
    available_count: Number.isFinite(payload?.available_count)
      ? payload.available_count
      : available.length,
    total_earned_count: Number.isFinite(payload?.total_earned_count)
      ? payload.total_earned_count
      : null,
    counts_by_status: countsByStatus,
    next_expiring_credit: available[0] || null,
  };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHumanCredits(credits, timeZone) {
  if (credits.length === 0) {
    console.log("No matching reset credits found.");
    return;
  }
  console.log(`Reset credits (${timeZone}):`);
  credits.forEach((credit, index) => {
    const source = credit.source ? ` from ${credit.source}` : "";
    console.log(
      `${index + 1}. ${credit.title || credit.reset_type || "Reset credit"} (${credit.status})${source}`,
    );
    console.log(`   Expires: ${credit.expires_local}`);
    console.log(`   UTC:     ${credit.expires_utc}`);
  });
}

function printHumanSummary(summary, timeZone) {
  console.log(`Available reset credits: ${summary.available_count}`);
  if (summary.total_earned_count !== null)
    console.log(`Total earned count: ${summary.total_earned_count}`);
  console.log(`Counts by status: ${JSON.stringify(summary.counts_by_status)}`);
  if (summary.next_expiring_credit) {
    console.log(
      `Next expiration (${timeZone}): ${summary.next_expiring_credit.expires_local}`,
    );
  }
}

function redactPathForOutput(filePath) {
  if (!filePath) return filePath;
  if (filePath === DEFAULT_AUTH_FILE) return "~/.codex/auth.json";
  const home = os.homedir();
  if (filePath === home) return "~";
  if (filePath.startsWith(`${home}${path.sep}`))
    return `~${filePath.slice(home.length)}`;
  return filePath;
}

function authFileForOutput(filePath, options) {
  if (options.showIdentifiers) return filePath;
  if (filePath === DEFAULT_AUTH_FILE) return "~/.codex/auth.json";
  return "[redacted auth file path]";
}

function authReport(auth, options) {
  return {
    source: "codex-default-auth-file",
    auth_file: authFileForOutput(auth.authFile, options),
    account_id: options.showIdentifiers ? auth.accountId : null,
    access_token_available: Boolean(auth.accessToken),
    token: tokenInfo(auth),
    base_url: options.baseUrl,
  };
}

async function commandDoctor(options) {
  let auth;
  try {
    auth = readAuth(options.authFile);
  } catch (error) {
    const result = {
      ok: false,
      auth: {
        source: "codex-default-auth-file",
        auth_file: authFileForOutput(options.authFile, options),
        access_token_available: false,
      },
      endpoint: { skipped: true },
      error: errorToJson(error, options),
    };
    if (options.json) printJson(result);
    else {
      console.log("Codex auth: missing or invalid");
      console.log(`Auth file: ${authFileForOutput(options.authFile, options)}`);
      console.log(`Error: ${error.message}`);
    }
    process.exitCode = 1;
    return;
  }

  try {
    const payload = await fetchCredits(auth, options);
    const summary = summarizePayload(payload, options.timeZone, options);
    const result = {
      ok: true,
      auth: authReport(auth, options),
      endpoint: {
        reachable: true,
        path: "/wham/rate-limit-reset-credits",
      },
      resets: summary,
    };
    if (options.json) printJson(result);
    else {
      console.log("Codex auth: OK");
      console.log(`Auth file: ${authFileForOutput(auth.authFile, options)}`);
      if (options.showIdentifiers)
        console.log(`Account ID: ${auth.accountId || "unknown"}`);
      console.log(
        `Endpoint: OK (${options.baseUrl}/wham/rate-limit-reset-credits)`,
      );
      printHumanSummary(summary, options.timeZone);
    }
  } catch (error) {
    const result = {
      ok: false,
      auth: authReport(auth, options),
      endpoint: {
        reachable: false,
        path: "/wham/rate-limit-reset-credits",
      },
      error: errorToJson(error, options),
    };
    if (options.json) printJson(result);
    else {
      console.log("Codex auth: found");
      if (options.showIdentifiers)
        console.log(`Account ID: ${auth.accountId || "unknown"}`);
      console.log(`Endpoint: failed: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

async function commandAccountCurrent(options) {
  const auth = readAuth(options.authFile);
  const result = {
    ok: true,
    account: {
      account_id: options.showIdentifiers ? auth.accountId : null,
      auth_file: authFileForOutput(auth.authFile, options),
      token: tokenInfo(auth),
    },
  };
  if (options.json) printJson(result);
  else {
    if (options.showIdentifiers)
      console.log(`Account ID: ${auth.accountId || "unknown"}`);
    console.log(`Auth file: ${authFileForOutput(auth.authFile, options)}`);
    if (result.account.token.expires_at)
      console.log(
        `Token expires: ${formatDate(result.account.token.expires_at, options.timeZone)}`,
      );
  }
}

async function commandCredits(options, args) {
  const subcommand = args[1];
  const auth = readAuth(options.authFile);
  const payload = await fetchCredits(auth, options);

  if (subcommand === "list") {
    const includeAll = args.includes("--all");
    const credits = normalizeCredits(
      payload,
      options.timeZone,
      includeAll,
      options,
    );
    const result = {
      ok: true,
      account_id: options.showIdentifiers ? auth.accountId : null,
      time_zone: options.timeZone,
      available_count: Number.isFinite(payload?.available_count)
        ? payload.available_count
        : credits.filter((c) => c.status === "available").length,
      total_earned_count: Number.isFinite(payload?.total_earned_count)
        ? payload.total_earned_count
        : null,
      credits,
    };
    if (options.json) printJson(result);
    else printHumanCredits(credits, options.timeZone);
    return;
  }

  if (subcommand === "summary") {
    const result = {
      ok: true,
      account_id: options.showIdentifiers ? auth.accountId : null,
      time_zone: options.timeZone,
      resets: summarizePayload(payload, options.timeZone, options),
    };
    if (options.json) printJson(result);
    else printHumanSummary(result.resets, options.timeZone);
    return;
  }

  throw new CliError("Expected credits list or credits summary", "BAD_ARGS");
}

async function commandRequest(options, args) {
  const method = args[1];
  const rawPath = args[2];
  if (method !== "get")
    throw new CliError("Only request get is supported", "BAD_ARGS");
  const auth = readAuth(options.authFile);
  const body = await requestJson(auth, options, "GET", rawPath);
  if (options.json) {
    printJson({ ok: true, path: endpointPath(rawPath), body });
  } else if (typeof body === "string") {
    console.log(body);
  } else {
    printJson(body);
  }
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function parseFlagValue(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  if (!args[index + 1])
    throw new CliError(`${flag} requires a value`, "BAD_ARGS");
  return args[index + 1];
}

function validateLaunchdLabel(label) {
  if (typeof label !== "string" || label.length < 1 || label.length > 128) {
    throw new CliError("--label must be 1-128 characters", "BAD_ARGS");
  }
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(label) ||
    label.includes("..")
  ) {
    throw new CliError(
      "--label must be a reverse-DNS style label using letters, numbers, dots, or hyphens",
      "BAD_ARGS",
    );
  }
  return label;
}

function buildLaunchdPlist(args, executablePath) {
  const intervalMinutes = Number(
    parseFlagValue(args, "--interval-minutes", "360"),
  );
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) {
    throw new CliError(
      "--interval-minutes must be a positive number",
      "BAD_ARGS",
    );
  }
  const label = validateLaunchdLabel(
    parseFlagValue(args, "--label", "com.codex-resets.check"),
  );
  const logDir = expandHome(
    parseFlagValue(
      args,
      "--log-dir",
      path.join(os.homedir(), ".codex", "resets"),
    ),
  );
  const command = parseFlagValue(args, "--command", "credits summary")
    .split(/\s+/)
    .filter(Boolean);
  const stdout = path.join(logDir, "codex-resets.log");
  const stderr = path.join(logDir, "codex-resets.err");
  const programArgs = path.isAbsolute(executablePath)
    ? [executablePath, "--json", ...command]
    : ["/usr/bin/env", executablePath, "--json", ...command];
  const programArgsXml = programArgs
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");

  return {
    label,
    interval_seconds: Math.round(intervalMinutes * 60),
    stdout,
    stderr,
    plist_path: path.join(
      os.homedir(),
      "Library",
      "LaunchAgents",
      `${label}.plist`,
    ),
    plist: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${xmlEscape(label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n${programArgsXml}\n  </array>\n  <key>StartInterval</key>\n  <integer>${Math.round(intervalMinutes * 60)}</integer>\n  <key>StandardOutPath</key>\n  <string>${xmlEscape(stdout)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xmlEscape(stderr)}</string>\n  <key>RunAtLoad</key>\n  <true/>\n</dict>\n</plist>\n`,
  };
}

async function commandSchedule(options, args) {
  if (args[1] !== "launchd-plist") {
    throw new CliError("Expected schedule launchd-plist", "BAD_ARGS");
  }
  const scheduleArgs = args.slice(2);
  const executablePath = parseFlagValue(
    scheduleArgs,
    "--executable",
    process.env.CODEX_RESETS_EXECUTABLE || process.argv[1] || "codex-resets",
  );
  const schedule = buildLaunchdPlist(scheduleArgs, executablePath);
  if (options.json) {
    printJson({ ok: true, schedule });
  } else {
    console.log(schedule.plist);
  }
}

function redactDetails(value, options) {
  if (!value || typeof value !== "object") return value;
  return JSON.parse(
    JSON.stringify(value, (key, nestedValue) => {
      if (/token|authorization|cookie|secret/i.test(key)) return "[redacted]";
      if (key === "authFile" || key === "auth_file")
        return authFileForOutput(nestedValue, options);
      if (typeof nestedValue === "string")
        return redactSensitiveString(nestedValue);
      return nestedValue;
    }),
  );
}

function errorToJson(error, options = { showIdentifiers: false }) {
  return {
    message: error.message,
    code: error.code || error.name || "ERROR",
    status: error.status || undefined,
    details: error.details ? redactDetails(error.details, options) : undefined,
  };
}

async function main(argv = process.argv.slice(2)) {
  const { options, args } = parseArgs(argv);
  if (options.help || args.length === 0) {
    if (options.json) printJson({ ok: true, help: HELP });
    else process.stdout.write(HELP);
    return;
  }

  const command = args[0];
  if (command === "doctor") return commandDoctor(options);
  if (command === "account" && args[1] === "current")
    return commandAccountCurrent(options);
  if (command === "credits") return commandCredits(options, args);
  if (command === "request") return commandRequest(options, args);
  if (command === "schedule") return commandSchedule(options, args);
  throw new CliError(`Unknown command: ${command}`, "BAD_ARGS");
}

if (require.main === module) {
  main().catch((error) => {
    let options = { json: false };
    try {
      options = parseArgs(process.argv.slice(2)).options;
    } catch {
      // Keep fallback error reporting simple if argument parsing itself failed.
    }
    if (options.json)
      printJson({ ok: false, error: errorToJson(error, options) });
    else {
      console.error(`Error: ${error.message}`);
      if (error.code === "BAD_ARGS")
        console.error("Run codex-resets --help for usage.");
    }
    process.exit(1);
  });
}

module.exports = {
  buildLaunchdPlist,
  decodeJwt,
  endpointPath,
  errorToJson,
  MAX_AUTH_FILE_BYTES,
  MAX_RESPONSE_BYTES,
  normalizeCredits,
  normalizeBaseUrl,
  parseArgs,
  redactBodyForError,
  readAuth,
  readResponseText,
  summarizePayload,
};
