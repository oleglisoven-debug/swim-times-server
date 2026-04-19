const express = require("express");
const puppeteer = require("puppeteer-core");
const cors = require("cors");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

const EVENT_MAP = {
  "50 FR":   "50m Free",   "100 FR":  "100m Free",  "200 FR":  "200m Free",
  "400 FR":  "400m Free",  "800 FR":  "800m Free",  "1500 FR": "1500m Free",
  "50 BK":   "50m Back",   "100 BK":  "100m Back",  "200 BK":  "200m Back",
  "50 BR":   "50m Breast", "100 BR":  "100m Breast","200 BR":  "200m Breast",
  "50 FL":   "50m Fly",    "100 FL":  "100m Fly",   "200 FL":  "200m Fly",
  "200 IM":  "200m IM",    "400 IM":  "400m IM"
};

// Ireland's numeric nation ID on Swimrankings
const IRELAND_NATION_ID = "IRL";

let browser = null;
async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || 
        (() => {
          const fs = require("fs");
          const paths = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
          for (const p of paths) { try { fs.accessSync(p); return p; } catch(e) {} }
          return "/usr/bin/chromium";
        })(),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu"
      ]
    });
  }
  return browser;
}

async function fetchPage(url) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-GB,en;q=0.9" });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 });
    // Try to dismiss cookie banner
    try {
      const btn = await page.$(".btn-accept, #accept, .cookie-accept, button[id*='accept'], button[class*='accept']");
      if (btn) await btn.click();
      await page.waitForTimeout(500);
    } catch(e) {}
    return await page.content();
  } finally {
    await page.close();
  }
}

async function searchSwimmer(name) {
  // Try with nation filter first, then without if no results
  const urls = [
    `https://www.swimrankings.net/index.php?page=athleteSelect&nationId=${IRELAND_NATION_ID}&selectPage=SEARCH&lastName=${encodeURIComponent(name)}`,
    `https://www.swimrankings.net/index.php?page=athleteSelect&nationId=0&selectPage=SEARCH&lastName=${encodeURIComponent(name)}`
  ];

  for (const url of urls) {
    const html = await fetchPage(url);

    // Log a snippet to help debug
    console.log("Search HTML snippet:", html.substring(0, 500));

    const results = [];

    // Primary pattern
    const rowRegex = /athleteId=(\d+)[^>]*>([^<]+)<\/a>[\s\S]{0,200}?class="club"[^>]*>([^<]*)[\s\S]{0,200}?class="birthDate"[^>]*>(\d{4})/gi;
    let m;
    while ((m = rowRegex.exec(html)) !== null) {
      results.push({ id: m[1].trim(), name: m[2].trim(), club: m[3].trim(), born: m[4].trim() });
    }

    // Fallback pattern — just grab any athleteId links
    if (results.length === 0) {
      const fallback = /athleteId=(\d+)[^>]*>\s*([A-Za-z][^<]{2,50})<\/a>/gi;
      while ((m = fallback.exec(html)) !== null) {
        const n = m[2].trim();
        if (n.length > 2 && !/^\d/.test(n)) {
          results.push({ id: m[1], name: n, club: "", born: "" });
        }
      }
    }

    const seen = {};
    const unique = results.filter(r => {
      if (seen[r.id]) return false;
      seen[r.id] = true;
      return true;
    }).slice(0, 8);

    if (unique.length > 0) return unique;
  }

  return [];
}

async function fetchAthleteTimes(athleteId) {
  const url = `https://www.swimrankings.net/index.php?page=athleteDetail&athleteId=${athleteId}&pbest=0`;
  const html = await fetchPage(url);

  const times = {};
  let swimmerName = "";

  const nameMatch = html.match(/class="athleteName"[^>]*>([^<]+)/i);
  if (nameMatch) swimmerName = nameMatch[1].trim();

  // Log snippet for debugging
  console.log("Times HTML snippet:", html.substring(0, 500));

  const rowRegex = /class="athleteBest[01][^"]*"([\s\S]*?)(?=class="athleteBest[01]|<\/table>)/gi;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const row = m[1];
    if (!row.match(/class="course"[^>]*>\s*LCM/i)) continue;
    const eventMatch = row.match(/class="event"[^>]*>[\s\S]*?>([^<]+)<\/a>/i);
    if (!eventMatch) continue;
    const timeMatch = row.match(/class="(?:time|swimtimeImportant)[^"]*"[^>]*>([\d:.]+)/i);
    if (!timeMatch) continue;
    const ourEvent = EVENT_MAP[eventMatch[1].trim()];
    if (ourEvent && !times[ourEvent]) times[ourEvent] = timeMatch[1].trim();
  }

  return { times, name: swimmerName };
}

app.get("/", (req, res) => {
  res.json({ status: "Swim Times Server running OK" });
});

app.get("/search", async (req, res) => {
  const name = (req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "Please provide a name" });

  try {
    const results = await searchSwimmer(name);
    if (results.length === 0) {
      return res.json({ results: [], message: "No swimmers found. Try surname only." });
    }
    if (results.length === 1) {
      const { times, name: swimmerName } = await fetchAthleteTimes(results[0].id);
      return res.json({ swimmer: results[0], times });
    }
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Search failed: " + err.message });
  }
});

app.get("/times", async (req, res) => {
  const athleteId = (req.query.athleteId || "").trim();
  if (!athleteId) return res.status(400).json({ error: "Please provide an athleteId" });

  try {
    const { times, name } = await fetchAthleteTimes(athleteId);
    res.json({ times, name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch times: " + err.message });
  }
});

// Debug endpoint — returns raw HTML of search so we can see what Swimrankings returns
app.get("/debug", async (req, res) => {
  const name = (req.query.name || "Murphy").trim();
  const url = `https://www.swimrankings.net/index.php?page=athleteSelect&nationId=IRL&selectPage=SEARCH&lastName=${encodeURIComponent(name)}`;
  try {
    const html = await fetchPage(url);
    res.set("Content-Type", "text/html");
    res.send(html);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Swim Times Server listening on port ${PORT}`);
});
