const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const { Server } = require("socket.io");
const Parser = require("rss-parser");
const axios = require("axios");
const cheerio = require("cheerio");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const NEWS24_RSS_URL = "http://feeds.news24.com/articles/news24/TopStories/rss";
const LOOPBACK_ORIGINS = [
  "http://127.0.0.1:8765",
  "http://localhost:8765",
  "http://127.0.0.1:3000",
  "http://localhost:3000"
];

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (!origin || LOOPBACK_ORIGINS.includes(origin) || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS blocked origin: ${origin}`));
    },
    methods: ["GET", "POST"]
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, "outputs")));
app.use(cors({
  origin(origin, callback) {
    if (!origin || LOOPBACK_ORIGINS.includes(origin) || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS blocked origin: ${origin}`));
  }
}));

const rssParser = new Parser({
  timeout: 15000,
  headers: {
    "user-agent": "SA-Situation-Monitor/1.0"
  }
});

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-1.5-flash" })
  : null;

const processedArticleIds = new Set();
const latestIncidents = [];
const latestOutages = [];
let latestGridStatus = {
  stage: 0,
  status: "UNKNOWN",
  source: "initializing",
  updatedAt: new Date().toISOString()
};
const automationState = {
  connectedClients: 0,
  currentOutages: latestOutages,
  currentLoadShedding: latestGridStatus
};

const southAfricanLocations = [
  { name: "Johannesburg", province: "Gauteng", lat: -26.2041, lon: 28.0473 },
  { name: "Pretoria", province: "Gauteng", lat: -25.7479, lon: 28.2293 },
  { name: "Tshwane", province: "Gauteng", lat: -25.7479, lon: 28.2293 },
  { name: "Soweto", province: "Gauteng", lat: -26.2678, lon: 27.8585 },
  { name: "Sandton", province: "Gauteng", lat: -26.1076, lon: 28.0567 },
  { name: "Midrand", province: "Gauteng", lat: -25.9992, lon: 28.1263 },
  { name: "Cape Town", province: "Western Cape", lat: -33.9249, lon: 18.4241 },
  { name: "Stellenbosch", province: "Western Cape", lat: -33.9321, lon: 18.8602 },
  { name: "George", province: "Western Cape", lat: -33.9648, lon: 22.4617 },
  { name: "Durban", province: "KwaZulu-Natal", lat: -29.8587, lon: 31.0218 },
  { name: "Pietermaritzburg", province: "KwaZulu-Natal", lat: -29.6006, lon: 30.3794 },
  { name: "Richards Bay", province: "KwaZulu-Natal", lat: -28.7807, lon: 32.0383 },
  { name: "Gqeberha", province: "Eastern Cape", lat: -33.9608, lon: 25.6022 },
  { name: "Port Elizabeth", province: "Eastern Cape", lat: -33.9608, lon: 25.6022 },
  { name: "East London", province: "Eastern Cape", lat: -33.0198, lon: 27.9033 },
  { name: "Mthatha", province: "Eastern Cape", lat: -31.5889, lon: 28.7844 },
  { name: "Bloemfontein", province: "Free State", lat: -29.0852, lon: 26.1596 },
  { name: "Welkom", province: "Free State", lat: -27.9777, lon: 26.7351 },
  { name: "Kimberley", province: "Northern Cape", lat: -28.7282, lon: 24.7499 },
  { name: "Upington", province: "Northern Cape", lat: -28.4478, lon: 21.2561 },
  { name: "Rustenburg", province: "North West", lat: -25.6676, lon: 27.2420 },
  { name: "Mahikeng", province: "North West", lat: -25.8652, lon: 25.6442 },
  { name: "Potchefstroom", province: "North West", lat: -26.7145, lon: 27.0970 },
  { name: "Mbombela", province: "Mpumalanga", lat: -25.4753, lon: 30.9694 },
  { name: "Nelspruit", province: "Mpumalanga", lat: -25.4753, lon: 30.9694 },
  { name: "Emalahleni", province: "Mpumalanga", lat: -25.8713, lon: 29.2332 },
  { name: "Polokwane", province: "Limpopo", lat: -23.9045, lon: 29.4689 },
  { name: "Musina", province: "Limpopo", lat: -22.3488, lon: 30.0436 },
  { name: "Thohoyandou", province: "Limpopo", lat: -22.9456, lon: 30.4849 }
];

const outageTargets = [
  { provider: "Vodacom", type: "mobile", province: "Gauteng", lat: -26.1076, lon: 28.0567 },
  { provider: "MTN", type: "mobile", province: "Gauteng", lat: -25.7479, lon: 28.2293 },
  { provider: "Telkom", type: "mobile/fibre", province: "Western Cape", lat: -33.9249, lon: 18.4241 },
  { provider: "FNB", type: "banking", province: "Gauteng", lat: -26.1076, lon: 28.0567 },
  { provider: "Standard Bank", type: "banking", province: "Gauteng", lat: -26.2041, lon: 28.0473 }
];

function stripHtml(input = "") {
  const $ = cheerio.load(`<main>${input}</main>`);
  return $("main").text().replace(/\s+/g, " ").trim();
}

function findBestLocation(text = "") {
  const lower = text.toLowerCase();
  return southAfricanLocations.find(location => lower.includes(location.name.toLowerCase())) || {
    name: "South Africa",
    province: "GLOBAL",
    lat: -30.5595,
    lon: 22.9375
  };
}

function classifyWithoutAi(article) {
  const text = `${article.title || ""} ${article.description || ""}`.toLowerCase();
  const location = findBestLocation(text);
  let category = "General Incident";
  let severity = "STABLE";

  if (/protest|march|strike|unrest|riot|shutdown|public order/.test(text)) {
    category = "Protest";
    severity = "WARNING";
  } else if (/water|dam|pipe|burst|reservoir|shortage|supply/.test(text)) {
    category = "Water Crisis";
    severity = "WARNING";
  } else if (/power|electricity|load.?shedding|eskom|grid|substation|road|rail|port|airport|bridge|fibre|fiber|network/.test(text)) {
    category = "Infrastructure";
    severity = "WARNING";
  }

  if (/dead|death|killed|fatal|evacuat|flood|fire|explosion|collapse|stage 6|stage 7|stage 8|critical|emergency/.test(text)) {
    severity = "CRITICAL";
  }

  return {
    title: article.title || "Untitled incident",
    description: article.description || "No description available.",
    category,
    severity,
    eventType: category === "Protest" ? "protest" : category === "Water Crisis" ? "water_outage" : category === "Infrastructure" ? "power_issue" : "other",
    city: location.name,
    confidence: location.name === "South Africa" ? 0.3 : 0.75,
    province: location.province,
    lat: location.lat,
    lon: location.lon
  };
}

function normaliseAiIncident(parsed, article) {
  const fallback = classifyWithoutAi(article);
  const lat = Number(parsed.lat);
  const lon = Number(parsed.lon);
  const severity = String(parsed.severity || fallback.severity).toUpperCase();
  const category = String(parsed.category || fallback.category);

  return {
    title: String(parsed.title || fallback.title).slice(0, 180),
    description: String(parsed.description || fallback.description).slice(0, 800),
    category: ["Protest", "Water Crisis", "Infrastructure", "General Incident"].includes(category) ? category : fallback.category,
    severity: ["STABLE", "WARNING", "CRITICAL"].includes(severity) ? severity : fallback.severity,
    eventType: String(parsed.event_type || parsed.eventType || fallback.eventType || "other"),
    city: String(parsed.city || fallback.city || "unknown"),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? fallback.confidence ?? 0.5))),
    province: fallback.province,
    lat: Number.isFinite(lat) ? lat : fallback.lat,
    lon: Number.isFinite(lon) ? lon : fallback.lon
  };
}

async function classifyWithAi(article) {
  const prompt = `
You are a South African situation-monitor analyst.
Classify this live news article and return ONLY valid JSON. No markdown. No explanation.
The JSON object must contain these keys:
title, description, category, severity, lat, lon, event_type, city, confidence

Rules:
- category must be one of: Protest, Water Crisis, Infrastructure, General Incident
- severity must be one of: STABLE, WARNING, CRITICAL
- event_type should be one of: protest, crime, accident, fire, water_outage, power_issue, medical_emergency, violence, looting, strike, other
- lat and lon must be precise South African coordinates inferred from the text.
- If the article is national or location is unclear, use South Africa center coordinates lat -30.5595 and lon 22.9375.
- Keep description under 80 words.

Article title: ${article.title}
Article description: ${article.description}
Article link: ${article.link}
`.trim();

  try {
    if (openai) {
      const response = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Return strict JSON only." },
          { role: "user", content: prompt }
        ]
      });

      const content = response.choices?.[0]?.message?.content || "{}";
      return normaliseAiIncident(JSON.parse(content), article);
    }

    if (gemini) {
      const result = await gemini.generateContent(prompt);
      const content = result.response.text().trim();
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      return normaliseAiIncident(JSON.parse(jsonMatch ? jsonMatch[0] : content), article);
    }

    return classifyWithoutAi(article);
  } catch (error) {
    console.warn(`[AI] Falling back to rule classifier: ${error.message}`);
    return classifyWithoutAi(article);
  }
}

function toFrontendCategory(category) {
  if (category === "Protest") return "GEOPOLITICAL";
  if (category === "Water Crisis") return "WATER/INFRASTRUCTURE";
  if (category === "Infrastructure") return "WATER/INFRASTRUCTURE";
  return "GEOPOLITICAL";
}

function severityScore(severity) {
  if (severity === "CRITICAL") return 9;
  if (severity === "WARNING") return 6;
  return 2;
}

function colorBySeverity(severity) {
  if (severity === "CRITICAL") return "#ff3b3b";
  if (severity === "WARNING") return "#ffb020";
  return "#31ff8a";
}

async function pollNews24() {
  try {
    const feed = await rssParser.parseURL(NEWS24_RSS_URL);
    const freshItems = (feed.items || [])
      .slice(0, 15)
      .filter(item => {
        const id = item.guid || item.id || item.link || item.title;
        return id && !processedArticleIds.has(id);
      })
      .reverse();

    for (const item of freshItems) {
      const articleId = item.guid || item.id || item.link || item.title;
      processedArticleIds.add(articleId);

      const article = {
        title: stripHtml(item.title || "News24 update"),
        description: stripHtml(item.contentSnippet || item.content || item.summary || ""),
        link: item.link || "",
        publishedAt: item.isoDate || item.pubDate || new Date().toISOString()
      };

      const parsed = await classifyWithAi(article);
      const incident = {
        id: `NEWS24-${Buffer.from(articleId).toString("base64url").slice(0, 12)}`,
        source: "News24 RSS",
        link: article.link,
        title: parsed.title,
        description: parsed.description,
        category: parsed.category,
        frontendCategory: toFrontendCategory(parsed.category),
        eventType: parsed.eventType,
        severity: parsed.severity,
        severityScore: severityScore(parsed.severity),
        status: parsed.severity,
        city: parsed.city,
        confidence: parsed.confidence,
        province: parsed.province,
        lat: parsed.lat,
        lon: parsed.lon,
        color: colorBySeverity(parsed.severity),
        receivedAt: new Date().toISOString()
      };

      latestIncidents.unshift(incident);
      latestIncidents.splice(50);
      io.emit("new-incident", incident);
      io.emit("newsUpdate", { articles: [incident] });
      console.log(`[News24] ${incident.severity} ${incident.category}: ${incident.title}`);
    }
  } catch (error) {
    console.error(`[News24] Poll failed: ${error.message}`);
  }
}

async function fetchEskomStatus() {
  if (process.env.ESKOMSEPUSH_API_KEY) {
    const response = await axios.get("https://developer.sepush.co.za/business/2.0/status", {
      timeout: 12000,
      headers: { token: process.env.ESKOMSEPUSH_API_KEY }
    });
    const stage = Number(response.data?.status?.eskom?.stage || 0);
    return {
      stage,
      status: stage > 0 ? `LOAD SHEDDING STAGE ${stage}` : "NO LOAD SHEDDING",
      source: "EskomSePush API",
      raw: response.data,
      updatedAt: new Date().toISOString()
    };
  }

  const stage = Number(process.env.MOCK_LOADSHEDDING_STAGE || Math.floor(Math.random() * 4));
  return {
    stage,
    status: stage > 0 ? `MOCK LOAD SHEDDING STAGE ${stage}` : "MOCK NO LOAD SHEDDING",
    source: "mocked local grid monitor",
    updatedAt: new Date().toISOString()
  };
}

async function pollGridStatus() {
  try {
    latestGridStatus = await fetchEskomStatus();
    automationState.currentLoadShedding = latestGridStatus;
    io.emit("grid-status", latestGridStatus);
    io.emit("eskomUpdate", {
      id: `ESKOM-${Date.now()}`,
      type: "eskom",
      title: `Eskom Stage ${latestGridStatus.stage ?? "Unknown"}`,
      description: latestGridStatus.status,
      stage: latestGridStatus.stage,
      severity: Math.min(10, Number(latestGridStatus.stage || 0)),
      color: latestGridStatus.stage > 4 ? "#ff3b3b" : latestGridStatus.stage > 0 ? "#ffb020" : "#31ff8a",
      timestamp: latestGridStatus.updatedAt,
      source: latestGridStatus.source
    });
    console.log(`[Grid] ${latestGridStatus.status}`);
  } catch (error) {
    latestGridStatus = {
      stage: null,
      status: "GRID API ERROR",
      source: "Eskom monitor",
      error: error.message,
      updatedAt: new Date().toISOString()
    };
    automationState.currentLoadShedding = latestGridStatus;
    io.emit("grid-status", latestGridStatus);
    console.error(`[Grid] Poll failed: ${error.message}`);
  }
}

function simulatedOutageWarning() {
  const target = outageTargets[Math.floor(Math.random() * outageTargets.length)];
  const score = Math.floor(35 + Math.random() * 65);
  const severity = score > 80 ? "CRITICAL" : score > 55 ? "WARNING" : "STABLE";
  const affectedRegions = {
    Vodacom: ["Gauteng", "Western Cape", "KwaZulu-Natal"],
    MTN: ["Gauteng", "Limpopo", "Mpumalanga"],
    Telkom: ["Free State", "Northern Cape", "North West"],
    FNB: ["Gauteng", "Western Cape"],
    "Standard Bank": ["Gauteng", "KwaZulu-Natal", "Western Cape"]
  }[target.provider] || [target.province];

  return {
    id: `OUTAGE-${Date.now()}-${target.provider.replace(/\s+/g, "-").toUpperCase()}`,
    provider: target.provider,
    type: target.type,
    province: target.province,
    status: severity,
    severity,
    title: `${target.provider} ${target.type} outage watch`,
    description: `${target.provider} ${target.type} complaints are being monitored. Simulated signal score: ${score}/100.`,
    affectedRegions,
    severityScore: severityScore(severity),
    color: colorBySeverity(severity),
    lat: target.lat,
    lon: target.lon,
    source: "simulated Downdetector ZA monitor",
    receivedAt: new Date().toISOString()
  };
}

async function pollDowndetectorSimulation() {
  const warning = simulatedOutageWarning();
  latestOutages.unshift(warning);
  latestOutages.splice(30);
  io.emit("infrastructure-outage", warning);
  io.emit("outageUpdate", { outages: [warning] });
  console.log(`[Outage] ${warning.severity} ${warning.provider}`);
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "sa-situation-monitor-realtime-backend",
    socket: "/socket.io/",
    updatedAt: new Date().toISOString()
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "outputs", "sa-situation-monitor.html"));
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "running",
    timestamp: new Date().toISOString(),
    loadSheddingStage: latestGridStatus.stage,
    connectedClients: automationState.connectedClients,
    outages: latestOutages,
    incidents: latestIncidents.length,
    aiProvider: openai ? "openai" : gemini ? "gemini" : "rule-based"
  });
});

app.get("/snapshot", (req, res) => {
  res.json({
    incidents: latestIncidents,
    grid: latestGridStatus,
    outages: latestOutages,
    updatedAt: new Date().toISOString()
  });
});

io.on("connection", socket => {
  automationState.connectedClients += 1;
  console.log(`[Socket] Client connected ${socket.id}`);
  socket.emit("currentState", {
    loadSheddingStage: latestGridStatus.stage,
    currentOutages: latestOutages,
    incidents: latestIncidents.slice(0, 10)
  });
  socket.emit("grid-status", latestGridStatus);
  latestIncidents.slice(0, 10).reverse().forEach(incident => socket.emit("new-incident", incident));
  latestOutages.slice(0, 10).reverse().forEach(outage => socket.emit("infrastructure-outage", outage));
  socket.on("requestUpdate", () => {
    socket.emit("currentState", {
      loadSheddingStage: latestGridStatus.stage,
      currentOutages: latestOutages,
      incidents: latestIncidents.slice(0, 10)
    });
  });
  socket.on("disconnect", () => {
    automationState.connectedClients = Math.max(0, automationState.connectedClients - 1);
    console.log(`[Socket] Client disconnected ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`SA real-time backend listening on http://localhost:${PORT}`);
  pollNews24();
  pollGridStatus();
  pollDowndetectorSimulation();
  setInterval(pollNews24, 60_000);
  setInterval(pollGridStatus, 30_000);
  setInterval(pollDowndetectorSimulation, 45_000);
});
