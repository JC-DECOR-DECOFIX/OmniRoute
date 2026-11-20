// Gen UI card for the phone: the same facts as the "Claude · Omni Route" panel, as a native view.
//
// `render(report, now, options)` turns the published usage report into a Gen UI document with the
// panel's own rules of what may be shown (quotaOf, accountBadge, reasonText, drawState in the
// panel's index.html), evaluated at `now` and formatted in one time zone. `createCardPublisher`
// decides when a new version of the card's artifact is written: only when the document changed,
// and at most once per minimum interval. Both are pure apart from what is injected.

import { redactCredentials } from "./aggregate.mjs";

export const CARD_FILE = "index.genui.json";

const MAX_ROWS = 30;
// Tolerated difference between a reading's time and this machine's clock (as in the panel).
const CLOCK_SKEW_MS = 60_000;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v ? v : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct = (v) => {
  const n = num(v);
  return n !== null && n >= 0 && n <= 100 ? n : null;
};
// Only the canonical ISO 8601 UTC form the service emits.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** A time from the report, or null when it is not one the service would have written. */
export function time(v) {
  const s = str(v);
  if (!s || !ISO.test(s)) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  // Date.parse rolls impossible dates over (02-30 becomes 03-02); only a round trip is real.
  const fraction = (s.match(/\.(\d{1,3})Z$/) || [null, ""])[1].padEnd(3, "0");
  const d = new Date(ms);
  return d.toISOString() === `${s.slice(0, 19)}.${fraction}Z` ? d : null;
}

/** Date and time formatting in one time zone, pt-BR, 24 h. */
export function clock(timeZone) {
  const format = new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = (d) => {
    const out = {};
    for (const p of format.formatToParts(d)) out[p.type] = p.value;
    return out;
  };
  const day = (d) => {
    const p = parts(d);
    return `${p.year}-${p.month}-${p.day}`;
  };
  const hm = (d) => {
    const p = parts(d);
    return `${p.hour}:${p.minute}`;
  };
  const hms = (d) => {
    const p = parts(d);
    return `${p.hour}:${p.minute}:${p.second}`;
  };
  const dm = (d) => {
    const p = parts(d);
    return `${p.day}/${p.month}`;
  };
  return (now) => {
    const today = day(new Date(now));
    const sameDay = (d) => day(d) === today;
    return {
      hm,
      hms,
      dm,
      sameDay,
      when: (d) => (sameDay(d) ? hm(d) : `${dm(d)} ${hm(d)}`),
      whenSeconds: (d) => (sameDay(d) ? hms(d) : `${dm(d)} ${hms(d)}`),
      resetText: (d) =>
        sameDay(d) ? `hoje ${hm(d)}` : `${parts(d).weekday.replace(".", "")} ${dm(d)} ${hm(d)}`,
      untilText: (d) =>
        sameDay(d) ? hm(d) : `${parts(d).weekday.replace(".", "")} ${dm(d)} ${hm(d)}`,
    };
  };
}

/**
 * A quota as the panel may show it. `known` is false when Omni Route holds no confirmed reading
 * of the account: then no number is shown at all.
 */
export function quotaOf(account, now) {
  const unknown = {
    known: false,
    readAt: null,
    stale: true,
    windows: { fiveHour: null, weekly: null },
  };
  const q = account && isObj(account.quota) ? account.quota : null;
  const readAt = q ? time(q.fetchedAt) : null;
  if (!q || str(q.status) === "unavailable" || !readAt || !isObj(q.windows)) return unknown;
  const windowOf = (name) => {
    // The report always names both windows; a missing key is a malformed reading.
    if (!Object.hasOwn(q.windows, name)) return { kind: "invalid" };
    const w = q.windows[name];
    // Null: the vendor did not report this window in the reading.
    if (w === null) return { kind: "absent" };
    if (!isObj(w)) return { kind: "invalid" };
    const resetsAt = time(w.resetsAt);
    if (str(w.state) === "reset_pending_reading") return { kind: "reset", resetsAt };
    const used = pct(w.usedPercent);
    if (used === null) return { kind: "invalid" };
    // A window whose reset passed since it was read no longer describes the account.
    if (resetsAt && resetsAt.getTime() <= now) return { kind: "reset", resetsAt };
    return { kind: "value", used, resetsAt, capturedAt: time(w.capturedAt) };
  };
  const windows = { fiveHour: windowOf("fiveHour"), weekly: windowOf("weekly") };
  const kinds = [windows.fiveHour.kind, windows.weekly.kind];
  // A malformed window, or a reading that reports neither window, cannot be trusted.
  if (kinds.includes("invalid") || kinds.every((k) => k === "absent")) return unknown;
  // Each shown number carries its own read time; the oldest one decides how current it is.
  const captures = [windows.fiveHour, windows.weekly]
    .filter((w) => w.kind === "value")
    .map((w) => w.capturedAt);
  const oldestAt =
    captures.length && captures.every(Boolean)
      ? new Date(Math.min(...captures.map((d) => d.getTime())))
      : null;
  const stale =
    str(q.status) !== "fresh" ||
    kinds.includes("reset") ||
    (captures.length > 0 && oldestAt === null);
  return { known: true, readAt, oldestAt, stale, windows };
}

/** The account's state badge, as the panel's accountBadge, with Gen UI tones. */
export function accountBadge(account, quota, isCurrent, fmt) {
  if (isCurrent) return { text: "Ativa", tone: "accent" };
  if (account.state === "cooldown") {
    const until = time(account.stateUntil);
    return { text: until ? `Em espera até ${fmt.hm(until)}` : "Em espera", tone: "warning" };
  }
  if (account.state !== "active" || !quota.known) return { text: "Indisponível" };
  if (quota.stale) return { text: "Desatualizado", tone: "warning" };
  if (account.inUse === true) return { text: "Em uso" };
  return { text: "Ociosa" };
}

const REASONS = [
  [/would exceed your account's rate limit/i, "limite de taxa da conta"],
  [/usage limit|limit reached/i, "limite de uso da conta"],
  [/Stream ended before producing/i, "stream terminou sem resposta"],
  [
    /no non-ping SSE event within|did not start within|timed? ?out|TIMEOUT/i,
    "sem resposta dentro do prazo",
  ],
  [/fetch failed/i, "falha de conexão com a Anthropic"],
  [/overloaded/i, "Anthropic sobrecarregada"],
  [/unauthori[sz]ed|invalid_grant|authentication/i, "autenticação recusada"],
];

/** Why a request moved to another account, as the panel says it. */
export function reasonText(reason) {
  const summary = str(reason && reason.summary) || "";
  for (const [pattern, text] of REASONS) if (pattern.test(summary)) return text;
  return summary.replace(/^\[\d+\]:\s*/, "") || "motivo não registrado";
}

/** Only a complete report is shown; anything else is treated as no report at all. */
export function validReport(v) {
  if (!isObj(v) || v.schema !== "omni-route-usage/v1" || !time(v.generatedAt)) return false;
  if (!isObj(v.observer) || !str(v.observer.status)) return false;
  if (!isObj(v.pool) || !Array.isArray(v.pool.authorized)) return false;
  if (!Array.isArray(v.accounts) || !Array.isArray(v.inUse) || !Array.isArray(v.switches)) {
    return false;
  }
  if (!v.accounts.every((a) => isObj(a) && str(a.connectionId))) return false;
  const side = (x) => isObj(x) && !!str(x.connectionId) && !!str(x.shortId);
  if (
    !v.inUse.every(
      (u) => isObj(u) && str(u.connectionId) && num(u.requests) !== null && time(u.lastAt)
    )
  ) {
    return false;
  }
  if (
    !v.switches.every(
      (s) =>
        isObj(s) &&
        time(s.at) &&
        side(s.from) &&
        side(s.to) &&
        isObj(s.reason) &&
        num(s.reason.status) !== null &&
        (s.outcome === "served" || s.outcome === "failed")
    )
  ) {
    return false;
  }
  if (v.current !== null && !(isObj(v.current) && str(v.current.connectionId))) return false;
  return true;
}

/**
 * The card's badge, as the panel's drawState at `now`. Atualizado: the active account's quota was
 * read within the freshness window and the service reads without errors. Desatualizado: an older
 * reading, or any part of the chain stopped; it keeps the reading's own time. Indisponível: no
 * confirmed reading of the active account.
 */
function stateBadge(report, quota, now, fmt) {
  const obs = report.observer;
  if (str(obs.status) === "unavailable" || !quota.known) return { text: "Indisponível" };
  const shownAt = quota.oldestAt || quota.readAt;
  const freshMs = num(report.thresholds && report.thresholds.quotaFreshMs);
  const stale =
    freshMs === null ||
    freshMs <= 0 ||
    quota.readAt.getTime() - now > CLOCK_SKEW_MS ||
    now - shownAt.getTime() > freshMs ||
    str(obs.status) !== "fresh" ||
    obs.lastError !== null ||
    quota.stale;
  return stale
    ? { text: `Desatualizado · lido ${fmt.when(shownAt)}`, tone: "warning" }
    : { text: `Atualizado · ${fmt.hm(shownAt)}`, tone: "success" };
}

const cell = (w) => {
  if (!w || w.kind !== "value") return "—";
  const text = `${Math.round(w.used)}%`;
  if (w.used >= 95) return { text, tone: "danger" };
  if (w.used >= 80) return { text, tone: "warning" };
  return text;
};

function resetCell(w, fmt, renewed) {
  if (!w || w.kind === "absent" || w.kind === "invalid") return "—";
  if (w.kind === "reset") {
    return w.resetsAt
      ? `${renewed} ${fmt.when(w.resetsAt)} · aguardando leitura`
      : `${renewed} · aguardando leitura`;
  }
  return w.resetsAt ? fmt.resetText(w.resetsAt) : "não informada";
}

function intervalText(ms) {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
}

/**
 * The Gen UI document for `report` at `now`. `timeZone` formats every time; `minIntervalMs` is
 * the publishing interval named in the footer. The document has no actions, and no text of it
 * carries a credential: any that reached the report is replaced by "[redacted]".
 */
export function render(report, now, options) {
  return redacted(draw(report, now, options));
}

function redacted(value) {
  if (typeof value === "string") return redactCredentials(value);
  if (Array.isArray(value)) return value.map(redacted);
  if (isObj(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redacted(child)]));
  }
  return value;
}

function draw(report, now, { timeZone = "America/Sao_Paulo", minIntervalMs = 300_000 } = {}) {
  const fmt = clock(timeZone)(now);
  const title = "Claude · Omni Route";
  if (!validReport(report) || str(report.observer.status) === "unavailable") {
    return {
      genui: 1,
      fallback: `${title}: relatório do Omni Route indisponível no momento.`,
      root: {
        type: "card",
        title,
        badge: { text: "Indisponível" },
        children: [{ type: "text", text: "Relatório do Omni Route indisponível no momento" }],
      },
    };
  }

  const r = report;
  const poolIds = r.pool.authorized.filter(str);
  const poolNumber = (shortId) => {
    const i = poolIds.indexOf(shortId);
    return i < 0 ? null : i + 1;
  };
  const cur = r.current;
  const curAccount = cur
    ? r.accounts.find((a) => a.connectionId === cur.connectionId) || null
    : null;
  const curQuota = quotaOf(curAccount, now);
  const curNumber = cur ? poolNumber(str(cur.shortId)) : null;
  const curName = cur ? str(cur.email) || str(cur.shortId) || "conta desconhecida" : null;

  // Em uso agora
  let usage;
  if (!cur) {
    usage = [{ label: "Em uso agora", value: "Nenhuma requisição recente", icon: "user" }];
  } else {
    const at = time(cur.at);
    usage = [
      {
        label: "Em uso agora",
        value: curNumber ? `Conta ${curNumber} · ${curName}` : curName,
        icon: "user",
      },
      { label: "Modelo", value: str(cur.effectiveModel) || "Indisponível" },
      {
        label: "Última requisição",
        value: at ? fmt.whenSeconds(at) : "Indisponível",
        icon: "clock",
      },
    ];
  }

  // Accounts of the pool, in pool order.
  const pool = r.accounts
    .filter((a) => a.authorized === true)
    .sort((x, y) => (poolNumber(x.shortId) ?? 99) - (poolNumber(y.shortId) ?? 99))
    .slice(0, MAX_ROWS);
  let fiveHourAbsent = false;
  const limits = [];
  const rows = pool.map((a) => {
    const isCurrent = !!cur && a.connectionId === cur.connectionId;
    const quota = quotaOf(a, now);
    const n = poolNumber(a.shortId);
    const name = str(a.email) || str(a.shortId) || "—";
    const five = quota.known ? quota.windows.fiveHour : null;
    const week = quota.known ? quota.windows.weekly : null;
    if (five && five.kind === "absent") fiveHourAbsent = true;
    if (!isCurrent) {
      const parts = [];
      if (five && five.kind === "value" && five.used >= 95) {
        parts.push(
          `5 h em ${Math.round(five.used)}%${five.resetsAt ? ` até ${fmt.untilText(five.resetsAt)}` : ""}`
        );
      }
      if (week && week.kind === "value" && week.used >= 95) {
        parts.push(
          `semana em ${Math.round(week.used)}%${week.resetsAt ? ` até ${fmt.untilText(week.resetsAt)}` : ""}`
        );
      }
      if (parts.length) limits.push(`conta ${n ?? name} com ${parts.join(" e ")}`);
    }
    return {
      conta: `${n ?? "—"} · ${name}`,
      h5: cell(five),
      h5z: resetCell(five, fmt, "zerou"),
      sem: cell(week),
      semr: resetCell(week, fmt, "renovou"),
      estado: accountBadge(a, quota, isCurrent, fmt),
    };
  });
  const outside = r.accounts
    .filter((a) => a.authorized !== true)
    .map(
      (a) =>
        `${str(a.email) || str(a.shortId) || "conta"}, ${
          a.testStatus === "expired"
            ? "expirada"
            : a.state === "active"
              ? "fora da lista autorizada"
              : "inativa"
        }`
    );
  const caption = [
    fiveHourAbsent ? "“—”: a Anthropic não informou a janela de 5 h dessa conta." : null,
    outside.length ? `Fora do pool: ${outside.join("; ")}.` : null,
  ].filter(Boolean);
  const table = {
    type: "table",
    columns: [
      { key: "conta", label: "Conta" },
      { key: "h5", label: "5 h", kind: "number" },
      { key: "h5z", label: "5 h zera" },
      { key: "sem", label: "Semana", kind: "number" },
      { key: "semr", label: "Semana renova" },
      { key: "estado", label: "Estado", kind: "badge" },
    ],
    rows,
    ...(caption.length ? { caption: caption.join(" ") } : {}),
  };

  // Última troca
  const latest = r.switches.find((s) => isObj(s) && time(s.at));
  let change;
  if (!latest) {
    change = [{ label: "Última troca", value: "Nenhuma nos últimos 7 dias", icon: "arrow-right" }];
  } else {
    const side = (s) => {
      const n = poolNumber(s && s.shortId);
      return n ? `conta ${n}` : str(s && s.email) || "fora do pool";
    };
    const status = num(latest.reason && latest.reason.status);
    const req = str(latest.requestedModel);
    const eff = str(latest.effectiveModel);
    const result = [];
    // Compared only when both models were recorded; the requested one is never inferred.
    if (req && eff) result.push(req === eff ? `mesmo modelo (${req})` : `modelo efetivo ${eff}`);
    else if (eff) result.push(`modelo efetivo ${eff}`);
    result.push(latest.outcome === "served" ? "atendida" : "falhou");
    change = [
      {
        label: "Última troca",
        value: `${fmt.when(time(latest.at))} · ${side(latest.from)} → ${side(latest.to)}`,
        icon: "arrow-right",
      },
      {
        label: "Motivo",
        value: `${status !== null ? `${status} · ` : ""}${reasonText(latest.reason)}`,
      },
      { label: "Resultado", value: result.join(", ") },
    ];
  }

  // Fallback: the same facts in one or two sentences.
  const shownAt = curQuota.known ? curQuota.oldestAt || curQuota.readAt : null;
  // Without a confirmed reading the stamp names none, so the time of each poll does not make a
  // new document.
  const stamp = shownAt
    ? `lido ${fmt.hm(shownAt)} de ${fmt.dm(shownAt)}`
    : "sem leitura confirmada de cota";
  let head;
  if (!cur) head = "nenhuma requisição recente";
  else {
    head = `em uso ${curNumber ? `a conta ${curNumber} (${curName})` : curName}`;
    const week = curQuota.known ? curQuota.windows.weekly : null;
    if (week && week.kind === "value") {
      head += `, semana em ${Math.round(week.used)}%`;
      if (week.resetsAt) head += `, renova ${fmt.resetText(week.resetsAt)}`;
    }
  }
  let fallback = `${title}, ${stamp}: ${head}.`;
  if (limits.length) {
    const text = limits.join("; ");
    fallback += ` ${text[0].toUpperCase()}${text.slice(1)}.`;
  }

  return {
    genui: 1,
    fallback,
    root: {
      type: "card",
      title,
      badge: stateBadge(r, curQuota, now, fmt),
      children: [
        { type: "keyvalue", items: usage },
        table,
        { type: "keyvalue", items: change },
        {
          type: "text",
          variant: "caption",
          text: `Fonte: Omni Route · cota de assinatura lida em api.anthropic.com/api/oauth/usage · cartão republicado quando algo muda, no máximo a cada ${intervalText(minIntervalMs)}`,
        },
      ],
    },
  };
}

const sortedKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!isObj(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortedKeys(value[key]);
  return out;
};

/**
 * Identity of a document: its JSON, compact, with every object's keys in sorted order (arrays
 * keep theirs), or null when the text is not JSON.
 */
export function canonical(text) {
  try {
    return JSON.stringify(sortedKeys(JSON.parse(text)));
  } catch {
    return null;
  }
}

// Documents the daemon refused, by identity; the oldest is forgotten past this many.
const MAX_REFUSED = 32;

/**
 * Publishes the card when its document changes, at most once per `minIntervalMs`.
 *
 * `read()` resolves with the artifact's latest `{ version, updatedAt, text }`; it is called before
 * the first publish and again after a conflict, so the card that is already there is not written
 * again and a restart does not shorten the interval. `write({ version, text, mutationId })`
 * resolves with `{ status, version?, errorCode?, paths? }`. A 409 or 412 reloads the artifact on
 * the next call; a 400 marks the document refused, so no refused document is sent again. A
 * failure is logged and tried again on the next call; it never throws.
 */
export function createCardPublisher({
  read,
  write,
  minIntervalMs,
  now = Date.now,
  log = () => {},
}) {
  let state = null;
  const refused = new Set();
  let inFlight = false;
  let sequence = 0;
  let lastLog = null;
  const note = (message) => {
    if (message !== lastLog) log(message);
    lastLog = message;
  };
  return async function publishCard(doc) {
    if (inFlight) return "busy";
    inFlight = true;
    try {
      if (state === null) {
        try {
          const latest = await read();
          state = {
            version: latest.version,
            canonical: canonical(latest.text ?? ""),
            publishedAt: Number.isFinite(latest.updatedAt) ? latest.updatedAt : null,
          };
        } catch (error) {
          note(`card state not read: ${error instanceof Error ? error.message : String(error)}`);
          return "failed";
        }
      }
      const text = canonical(JSON.stringify(doc));
      if (text === state.canonical) return "unchanged";
      if (refused.has(text)) return "refused";
      if (state.publishedAt !== null && now() - state.publishedAt < minIntervalMs) return "waiting";
      sequence += 1;
      let result;
      try {
        result = await write({
          version: state.version,
          text: `${JSON.stringify(doc, null, 2)}\n`,
          mutationId: `card-${now()}-${sequence}`,
        });
      } catch (error) {
        note(`card publish failed: ${error instanceof Error ? error.message : String(error)}`);
        return "failed";
      }
      if (result.status >= 200 && result.status < 300 && typeof result.version === "string") {
        state = { version: result.version, canonical: text, publishedAt: now() };
        note("card published");
        lastLog = null;
        return "written";
      }
      if (result.status === 409 || result.status === 412) {
        state = null;
        note(`card conflict: HTTP ${result.status}, reloading`);
        return "conflict";
      }
      if (result.status === 400) {
        refused.add(text);
        if (refused.size > MAX_REFUSED) refused.delete(refused.values().next().value);
        const paths = (result.paths ?? []).join(", ");
        note(
          `card refused: HTTP 400${result.errorCode ? ` ${result.errorCode}` : ""}${paths ? ` at ${paths}` : ""}`
        );
        return "refused";
      }
      note(`card publish failed: HTTP ${result.status}`);
      return "failed";
    } finally {
      inFlight = false;
    }
  };
}
