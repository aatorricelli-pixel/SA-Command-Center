import "dotenv/config";
import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";
import pg from "pg";

const { Pool } = pg;

const REQUIRED_ENV = ["DATABASE_URL"];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length) {
  throw new Error(`Missing required env vars: ${missing.join(", ")}`);
}

const config = {
  pollIntervalMs: Number(process.env.POLL_INTERVAL_SECONDS || 300) * 1000,
  normalResolveHours: Number(process.env.NORMAL_RESOLVE_HOURS || 24),
  criticalResolveHours: Number(process.env.CRITICAL_RESOLVE_HOURS || 48),
  dedupRadiusMeters: Number(process.env.DEDUP_RADIUS_KM || 15) * 1000,
  dedupLookbackHours: Number(process.env.DEDUP_LOOKBACK_HOURS || 4),
  titleSimilarityThreshold: Number(process.env.TITLE_SIMILARITY_THRESHOLD || 0.72),
  trafficAlertsUrl: process.env.TRAFFIC_ALERTS_URL || "https://www.i-traffic.co.za/region/Gauteng",
  cityPowerStatusUrl: process.env.CITY_POWER_STATUS_URL || "https://www.citypower.co.za/",
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 15_000),
  fetchRetries: Number(process.env.FETCH_RETRIES || 2),
  acledEventsUrl: process.env.ACLED_EVENTS_URL || "https://api.acleddata.com/acled/read",
  acledCountry: process.env.ACLED_COUNTRY || "South Africa"
};

const sourceFreshness = new Map();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000
});

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text"
});

const sourceFeeds = [
  {
    name: "News24 Top Stories",
    category: "geopolitical",
    url: "http://feeds.news24.com/articles/news24/TopStories/rss"
  }
];

const locationGazetteer = [
  ["Johannesburg", "Gauteng", 28.0473, -26.2041],
  ["Sandton", "Gauteng", 28.0567, -26.1076],
  ["Midrand", "Gauteng", 28.1263, -25.9992],
  ["Soweto", "Gauteng", 27.8585, -26.2678],
  ["Pretoria", "Gauteng", 28.2293, -25.7479],
  ["Tshwane", "Gauteng", 28.2293, -25.7479],
  ["Centurion", "Gauteng", 28.1881, -25.8601],
  ["Benoni", "Gauteng", 28.3208, -26.1885],
  ["Boksburg", "Gauteng", 28.2625, -26.2129],
  ["N1", "Gauteng", 28.126, -25.9895],
  ["N3", "Gauteng", 28.141, -26.202],
  ["Cape Town", "Western Cape", 18.4241, -33.9249],
  ["Stellenbosch", "Western Cape", 18.8602, -33.9321],
  ["George", "Western Cape", 22.4617, -33.9648],
  ["Paarl", "Western Cape", 18.9558, -33.7342],
  ["Durban", "KwaZulu-Natal", 31.0218, -29.8587],
  ["Pietermaritzburg", "KwaZulu-Natal", 30.3794, -29.6006],
  ["Richards Bay", "KwaZulu-Natal", 32.0383, -28.7807],
  ["Newcastle", "KwaZulu-Natal", 29.9327, -27.7574],
  ["Gqeberha", "Eastern Cape", 25.6022, -33.9608],
  ["Port Elizabeth", "Eastern Cape", 25.6022, -33.9608],
  ["East London", "Eastern Cape", 27.9033, -33.0198],
  ["Mthatha", "Eastern Cape", 28.7844, -31.5889],
  ["Bloemfontein", "Free State", 26.1596, -29.0852],
  ["Welkom", "Free State", 26.7351, -27.9777],
  ["Kimberley", "Northern Cape", 24.7499, -28.7282],
  ["Upington", "Northern Cape", 21.2561, -28.4478],
  ["Rustenburg", "North West", 27.242, -25.6676],
  ["Mahikeng", "North West", 25.6442, -25.8652],
  ["Potchefstroom", "North West", 27.097, -26.7145],
  ["Mbombela", "Mpumalanga", 30.9694, -25.4753],
  ["Nelspruit", "Mpumalanga", 30.9694, -25.4753],
  ["Emalahleni", "Mpumalanga", 29.2332, -25.8713],
  ["Polokwane", "Limpopo", 29.4689, -23.9045],
  ["Musina", "Limpopo", 30.0436, -22.3488],
  ["Thohoyandou", "Limpopo", 30.4849, -22.9456]
].map(([name, province, lon, lat]) => ({ name, province, lon, lat }));

function stripHtml(input = "") {
  return String(input)
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseText(input = "") {
  return stripHtml(input).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function titleSimilarity(a, b) {
  const left = new Set(normaliseText(a).split(" ").filter((word) => word.length > 2));
  const right = new Set(normaliseText(b).split(" ").filter((word) => word.length > 2));
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return intersection / union;
}

function classifyIncident(text, fallbackCategory = "general") {
  const value = normaliseText(text);
  if (/flood|rain|storm|fire|heat|weather|dam|river/.test(value)) return "natural_disaster";
  if (/water|pipe|burst|reservoir|electricity|power|substation|load shedding|loadshedding|outage|fiber|fibre|network/.test(value)) return "infrastructure";
  if (/road|traffic|collision|crash|accident|n1|n2|n3|n4|n7|rail|train|highway/.test(value)) return "traffic";
  if (/rand|jse|market|bank|stock|fuel|petrol|diesel|gold|silver|bitcoin/.test(value)) return "financial";
  if (/protest|strike|unrest|march|election|minister|government|court|crime|police/.test(value)) return "geopolitical";
  return fallbackCategory;
}

function classifySeverity(text) {
  const value = normaliseText(text);
  if (/critical|fatal|dead|death|killed|evacuat|collapse|explosion|stage 6|stage 7|stage 8|disaster|emergency/.test(value)) return "critical";
  if (/warning|active|delay|outage|collision|protest|strike|flood|fire|stage [1-5]|investigating/.test(value)) return "warning";
  return "stable";
}

function initialStatus(severity) {
  return severity === "stable" ? "investigating" : "active";
}

function findLocation(text) {
  const value = normaliseText(text);
  const matched = locationGazetteer.find((entry) => value.includes(entry.name.toLowerCase()));
  if (matched) return matched;
  return { name: "South Africa", province: "National", lon: 22.9375, lat: -30.5595 };
}

function toWktPoint(lon, lat) {
  return `POINT(${Number(lon).toFixed(6)} ${Number(lat).toFixed(6)})`;
}

function normaliseRssItems(parsed, source) {
  const channel = parsed?.rss?.channel;
  const items = Array.isArray(channel?.item) ? channel.item : channel?.item ? [channel.item] : [];
  return items.map((item) => {
    const title = stripHtml(item.title);
    const description = stripHtml(item.description || item["content:encoded"] || item.summary || "");
    const incidentTime = item.pubDate ? new Date(item.pubDate) : new Date();
    return buildIncident({
      title,
      description,
      sourceName: source.name,
      sourceUrl: item.link || source.url,
      incidentTime,
      fallbackCategory: source.category
    });
  });
}

function buildIncident({ title, description, sourceName, sourceUrl, incidentTime, fallbackCategory }) {
  const combined = `${title} ${description}`;
  const location = findLocation(combined);
  const category = classifyIncident(combined, fallbackCategory);
  const severity = classifySeverity(combined);
  const status = initialStatus(severity);

  return {
    title: title || "Untitled live incident",
    description: description || "No description supplied by source.",
    category,
    severity,
    status,
    incident_time: incidentTime instanceof Date && !Number.isNaN(incidentTime.getTime()) ? incidentTime : new Date(),
    source_name: sourceName,
    source_url: sourceUrl,
    location_name: location.name,
    province: location.province,
    lon: location.lon,
    lat: location.lat,
    location_wkt: toWktPoint(location.lon, location.lat)
  };
}

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt <= config.fetchRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "user-agent": "SA-Command-Center-Ingestion/1.0",
          accept: "text/html,application/rss+xml,application/xml,text/xml,application/json;q=0.9,*/*;q=0.8",
          ...(options.headers || {})
        }
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < config.fetchRetries) {
        await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

async function fetchText(url) {
  const response = await fetchWithRetry(url);
  return response.text();
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithRetry(url, options);
  return response.json();
}

function markSource(name, status, details = {}) {
  sourceFreshness.set(name, {
    status,
    checked_at: new Date().toISOString(),
    ...details
  });
}

async function fetchRssSource(source) {
  const xml = await fetchText(source.url);
  return normaliseRssItems(xmlParser.parse(xml), source);
}

async function fetchTrafficAlerts() {
  try {
    const html = await fetchText(config.trafficAlertsUrl);
    const $ = cheerio.load(html);
    const candidates = [];

    $("article, .event, .incident, .alert, li").each((_, element) => {
      const text = $(element).text().replace(/\s+/g, " ").trim();
      if (text.length > 35 && /road|traffic|n1|n2|n3|n4|accident|crash|delay/i.test(text)) {
        candidates.push(text.slice(0, 600));
      }
    });

    return candidates.slice(0, 20).map((text) => buildIncident({
      title: text.slice(0, 120),
      description: text,
      sourceName: "i-TRAFFIC public alert wrapper",
      sourceUrl: config.trafficAlertsUrl,
      incidentTime: new Date(),
      fallbackCategory: "traffic"
    }));
  } catch (error) {
    console.warn(`[traffic] ${error.message}`);
    return [];
  }
}

async function fetchCityPowerWrapper() {
  try {
    const html = await fetchText(config.cityPowerStatusUrl);
    const $ = cheerio.load(html);
    const text = $("body").text().replace(/\s+/g, " ").trim();
    if (!/outage|power|electricity|interruption|load/i.test(text)) return [];

    return [buildIncident({
      title: "City Power public status page requires review",
      description: text.slice(0, 900),
      sourceName: "City Power public status wrapper",
      sourceUrl: config.cityPowerStatusUrl,
      incidentTime: new Date(),
      fallbackCategory: "infrastructure"
    })];
  } catch (error) {
    console.warn(`[city-power] ${error.message}`);
    return [];
  }
}

async function fetchEskomWrapper() {
  if (!process.env.ESKOMSEPUSH_API_KEY) {
    return [buildIncident({
      title: "Eskom grid monitor wrapper active",
      description: "EskomSePush API key not configured. Worker is ready to ingest official grid stage once ESKOMSEPUSH_API_KEY is provided.",
      sourceName: "EskomSePush wrapper",
      sourceUrl: "https://eskomsepush.co.za/api",
      incidentTime: new Date(),
      fallbackCategory: "infrastructure"
    })];
  }

  const response = await fetch("https://developer.sepush.co.za/business/2.0/status", {
    headers: { token: process.env.ESKOMSEPUSH_API_KEY }
  });
  if (!response.ok) throw new Error(`EskomSePush returned ${response.status}`);
  const data = await response.json();
  const stage = Number(data?.status?.eskom?.stage || 0);
  if (stage <= 0) return [];

  return [buildIncident({
    title: `Load shedding stage ${stage}`,
    description: `National Eskom grid status reports load shedding stage ${stage}.`,
    sourceName: "EskomSePush API",
    sourceUrl: "https://eskomsepush.co.za/api",
    incidentTime: new Date(),
    fallbackCategory: "infrastructure"
  })];
}

async function getAcledToken() {
  const email = (process.env.ACLED_EMAIL || "").trim();
  const password = (process.env.ACLED_PASSWORD || "").trim();
  const staticToken = (process.env.ACLED_ACCESS_TOKEN || "").trim();

  if (email && password) {
    const body = new URLSearchParams({
      username: email,
      password,
      grant_type: "password",
      client_id: "acled"
    });

    try {
      const response = await fetchWithRetry("https://acleddata.com/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body
      });
      const data = await response.json();
      if (data.access_token) return data.access_token;
    } catch (error) {
      console.warn(`[acled] OAuth token exchange failed: ${error.message}`);
    }
  }

  return staticToken || null;
}

async function fetchAcledSouthAfricaEvents() {
  const token = await getAcledToken();
  if (!token) {
    markSource("ACLED", "skipped", { reason: "No ACLED credentials configured" });
    return [];
  }

  try {
    const since = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const url = new URL(config.acledEventsUrl);
    url.searchParams.set("country", config.acledCountry);
    url.searchParams.set("event_date", since);
    url.searchParams.set("event_date_where", ">=");
    url.searchParams.set("limit", "50");

    const data = await fetchJson(url.toString(), {
      headers: { authorization: `Bearer ${token}` }
    });

    const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    markSource("ACLED", "ok", { count: rows.length });
    return rows.map((event) => {
      const lon = Number(event.longitude);
      const lat = Number(event.latitude);
      const title = `${event.event_type || "Security event"} - ${event.location || config.acledCountry}`;
      const description = [
        event.notes,
        event.sub_event_type ? `Sub-event: ${event.sub_event_type}` : "",
        event.actor1 ? `Actor 1: ${event.actor1}` : "",
        event.actor2 ? `Actor 2: ${event.actor2}` : ""
      ].filter(Boolean).join(" | ");

      return buildIncident({
        title,
        description,
        sourceName: "ACLED",
        sourceUrl: "https://acleddata.com/",
        incidentTime: event.event_date ? new Date(event.event_date) : new Date(),
        fallbackCategory: "geopolitical"
      });
    }).filter((incident, index) => {
      const event = rows[index];
      const lon = Number(event?.longitude);
      const lat = Number(event?.latitude);
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        incident.lon = lon;
        incident.lat = lat;
        incident.location_wkt = toWktPoint(lon, lat);
      }
      return Number.isFinite(incident.lon) && Number.isFinite(incident.lat);
    });
  } catch (error) {
    markSource("ACLED", "error", { error: error.message });
    console.warn(`[acled] ${error.message}`);
    return [];
  }
}

async function collectIncidents() {
  const sources = [
    ...sourceFeeds.map((source) => ({
      name: source.name,
      fn: () => fetchRssSource(source)
    })),
    { name: "i-TRAFFIC", fn: fetchTrafficAlerts },
    { name: "City Power", fn: fetchCityPowerWrapper },
    { name: "EskomSePush", fn: fetchEskomWrapper },
    { name: "ACLED", fn: fetchAcledSouthAfricaEvents }
  ];

  const batches = await Promise.allSettled(sources.map(async (source) => {
    const value = await source.fn();
    if (!sourceFreshness.has(source.name)) {
      markSource(source.name, "ok", { count: value.length });
    }
    return value;
  }));

  return batches.flatMap((result, index) => {
    if (result.status === "fulfilled") return result.value;
    markSource(sources[index].name, "error", { error: result.reason.message });
    console.warn(`[collector:${sources[index].name}] ${result.reason.message}`);
    return [];
  });
}

async function findDuplicate(client, incident) {
  const { rows } = await client.query(
    `
      SELECT id, title, description, incident_time,
             ST_X(location::geometry) AS lon,
             ST_Y(location::geometry) AS lat
      FROM public.live_incidents
      WHERE status IN ('active', 'investigating')
        AND incident_time >= NOW() - ($1::int * INTERVAL '1 hour')
        AND ST_DWithin(
          location::geography,
          ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
          $4
        )
      ORDER BY incident_time DESC
      LIMIT 25
    `,
    [config.dedupLookbackHours, incident.lon, incident.lat, config.dedupRadiusMeters]
  );

  return rows.find((row) => titleSimilarity(row.title, incident.title) >= config.titleSimilarityThreshold) || null;
}

async function appendToDuplicate(client, duplicate, incident) {
  const note = `\n\n[${new Date().toISOString()} // ${incident.source_name}] ${incident.description}`;
  await client.query(
    `
      UPDATE public.live_incidents
      SET description = LEFT(COALESCE(description, '') || $1, 6000),
          incident_time = GREATEST(incident_time, $2),
          updated_at = NOW()
      WHERE id = $3
    `,
    [note, incident.incident_time, duplicate.id]
  );
}

async function insertIncident(client, incident) {
  await client.query(
    `
      INSERT INTO public.live_incidents
        (title, description, category, severity, status, incident_time, source_name, source_url, location_name, province, location, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ST_GeomFromText($11, 4326), NOW(), NOW())
    `,
    [
      incident.title,
      incident.description,
      incident.category,
      incident.severity,
      incident.status,
      incident.incident_time,
      incident.source_name,
      incident.source_url,
      incident.location_name,
      incident.province,
      incident.location_wkt
    ]
  );
}

async function upsertIncident(client, incident) {
  const duplicate = await findDuplicate(client, incident);
  if (duplicate) {
    await appendToDuplicate(client, duplicate, incident);
    return { action: "appended", title: incident.title };
  }
  await insertIncident(client, incident);
  return { action: "inserted", title: incident.title };
}

async function archiveStaleIncidents(client) {
  const { rowCount } = await client.query(
    `
      UPDATE public.live_incidents
      SET status = 'resolved',
          updated_at = NOW()
      WHERE status IN ('active', 'investigating')
        AND (
          (severity = 'critical' AND incident_time < NOW() - ($1::int * INTERVAL '1 hour'))
          OR
          (severity <> 'critical' AND incident_time < NOW() - ($2::int * INTERVAL '1 hour'))
        )
    `,
    [config.criticalResolveHours, config.normalResolveHours]
  );
  return rowCount;
}

async function runIngestionCycle() {
  const client = await pool.connect();
  try {
    const incidents = await collectIncidents();
    const results = [];

    await client.query("BEGIN");
    for (const incident of incidents) {
      if (!incident.title || !Number.isFinite(incident.lon) || !Number.isFinite(incident.lat)) continue;
      results.push(await upsertIncident(client, incident));
    }
    const archived = await archiveStaleIncidents(client);
    await client.query("COMMIT");

    console.log(JSON.stringify({
      cycle_at: new Date().toISOString(),
      collected: incidents.length,
      inserted: results.filter((item) => item.action === "inserted").length,
      appended: results.filter((item) => item.action === "appended").length,
      archived,
      sources: Object.fromEntries(sourceFreshness.entries())
    }));
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`[cycle] ${error.stack || error.message}`);
  } finally {
    client.release();
  }
}

async function main() {
  await runIngestionCycle();
  if (process.env.RUN_ONCE === "true") {
    await pool.end();
    return;
  }

  setInterval(runIngestionCycle, config.pollIntervalMs);
}

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
