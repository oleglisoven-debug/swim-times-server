const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
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

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--window-size=1920,1080",
        "--shm-size=1gb"
      ]
    });
  }
  return browser;
}

async function fetchPage(url) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    // Set realistic viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-IE,en-GB;q=0.9,en;q=0.8",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
    });

    // Visit homepage first to establish session and pass Cloudflare
    await page.goto("https://www.swimrankings.net/index.php", {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    // Human-like delay
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));

    // Accept cookies if banner appears
    try {
      await page.click("#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", { timeout: 3000 });
      await new Promise(r => setTimeout(r, 500));
    } catch(e) {}

    // Now navigate to the actual page
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for Cloudflare to clear if needed
    for (let i = 0; i < 8; i++) {
      const content = await page.content();
      if (!content.includes("security verification") && !content.includes("cf-browser-verification")) break;
      await new Promise(r => setTimeout(r, 3000));
    }

    return await page.content();
  } finally {
    await page.close();
  }
}

async function searchSwimmer(name) {
  const encoded = encodeURIComponent(name);
  const url = `https://www.swimrankings.net/index.php?page=athleteSelect&nationId=IRL&selectPage=SEARCH&lastName=${encoded}`;
  const html = await fetchPage(url);

  const results = [];
  const rowRegex = /athleteId=(\d+)[^>]*>([^<]+)<\/a>[\s\S]{0,300}?class="club"[^>]*>([^<]*)[\s\S]{0,300}?class="birthDate"[^>]*>(\d{4})/gi;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    results.push({ id: m[1].trim(), name: m[2].trim(), club: m[3].trim(), born: m[4].trim() });
  }

  if (results.length === 0) {
    const fallback = /athleteId=(\d+)[^>]*>\s*([A-Z][^<]{2,50})<\/a>/gi;
    while ((m = fallback.exec(html)) !== null) {
      const n = m[2].trim();
      if (n.length > 2) results.push({ id: m[1], name: n, club: "", born: "" });
    }
  }

  const seen = {};
  return results.filter(r => {
    if (seen[r.id]) return false;
    seen[r.id] = true;
    return true;
  }).slice(0, 8);
}

async function fetchAthleteTimes(athleteId) {
  const url = `https://www.swimrankings.net/index.php?page=athleteDetail&athleteId=${athleteId}&pbest=0`;
  const html = await fetchPage(url);

  const times = {};
  let swimmerName = "";

  const nameMatch = html.match(/class="athleteName"[^>]*>([^<]+)/i);
  if (nameMatch) swimmerName = nameMatch[1].trim();

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

app.get("/", (req, res) => res.json({ status: "Swim Times Server running OK" }));

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

app.get("/search", async (req, res) => {
  const name = (req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "Please provide a name" });
  try {
    const results = await searchSwimmer(name);
    if (results.length === 0) return res.json({ results: [], message: "No swimmers found. Try surname only." });
    if (results.length === 1) {
      const { times } = await fetchAthleteTimes(results[0].id);
      return res.json({ swimmer: results[0], times });
    }
    res.json({ results });
  } catch (err) {
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
    res.status(500).json({ error: "Failed: " + err.message });
  }
});

app.listen(PORT, () => console.log(`Swim Times Server listening on port ${PORT}`));
