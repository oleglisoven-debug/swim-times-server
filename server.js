const express = require("express");
const https = require("https");
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

// Realistic browser headers that rotate to avoid detection
const HEADERS = [
  {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-IE,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0"
  },
  {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1"
  }
];

let cookieJar = "";
let requestCount = 0;

function getHeaders() {
  const h = HEADERS[requestCount % HEADERS.length];
  requestCount++;
  if (cookieJar) h["Cookie"] = cookieJar;
  return h;
}

function fetchURL(url) {
  return new Promise(function(resolve, reject) {
    const options = {
      headers: getHeaders(),
      timeout: 15000
    };

    const req = https.get(url, options, function(res) {
      // Store cookies for session continuity
      if (res.headers["set-cookie"]) {
        const newCookies = res.headers["set-cookie"]
          .map(c => c.split(";")[0])
          .join("; ");
        cookieJar = cookieJar ? cookieJar + "; " + newCookies : newCookies;
      }

      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirect = res.headers.location;
        if (!redirect.startsWith("http")) {
          redirect = "https://www.swimrankings.net" + redirect;
        }
        return fetchURL(redirect).then(resolve).catch(reject);
      }

      const chunks = [];
      res.on("data", function(c) { chunks.push(c); });
      res.on("end", function() {
        resolve(Buffer.concat(chunks).toString("latin1"));
      });
    });

    req.on("error", reject);
    req.on("timeout", function() {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });
}

// Warm up session by visiting homepage first
async function warmUpSession() {
  try {
    await fetchURL("https://www.swimrankings.net/index.php");
    // Small delay to look human
    await new Promise(r => setTimeout(r, 800));
  } catch(e) {
    console.log("Warmup failed:", e.message);
  }
}

async function searchSwimmer(name) {
  // Warm up session first
  await warmUpSession();

  const encoded = encodeURIComponent(name);
  const urls = [
    `https://www.swimrankings.net/index.php?page=athleteSelect&nationId=IRL&selectPage=SEARCH&lastName=${encoded}`,
    `https://www.swimrankings.net/index.php?page=athleteSelect&nationId=0&selectPage=SEARCH&lastName=${encoded}`
  ];

  for (const url of urls) {
    await new Promise(r => setTimeout(r, 500));
    const html = await fetchURL(url);

    console.log("Search response length:", html.length);
    console.log("Search snippet:", html.substring(0, 300));

    const results = [];

    // Primary pattern matching Swimrankings HTML structure
    const rowRegex = /class="athleteSearch[01][^"]*"[\s\S]*?athleteId=(\d+)[^>]*>([^<]+)<\/a>[\s\S]*?class="club"[^>]*>([^<]*)[\s\S]*?class="birthDate"[^>]*>(\d{4})/gi;
    let m;
    while ((m = rowRegex.exec(html)) !== null) {
      results.push({ id: m[1].trim(), name: m[2].trim(), club: m[3].trim(), born: m[4].trim() });
    }

    // Fallback
    if (results.length === 0) {
      const fallback = /athleteId=(\d+)[^>]*>\s*([A-Z][^<]{2,50})<\/a>/gi;
      while ((m = fallback.exec(html)) !== null) {
        const n = m[2].trim();
        if (n.length > 2 && !/\d/.test(n.charAt(0))) {
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
  await new Promise(r => setTimeout(r, 500));
  const url = `https://www.swimrankings.net/index.php?page=athleteDetail&athleteId=${athleteId}&pbest=0`;
  const html = await fetchURL(url);

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

app.get("/", (req, res) => {
  res.json({ status: "Swim Times Server running OK" });
});

app.get("/debug", async (req, res) => {
  const name = (req.query.name || "Murphy").trim();
  await warmUpSession();
  const url = `https://www.swimrankings.net/index.php?page=athleteSelect&nationId=IRL&selectPage=SEARCH&lastName=${encodeURIComponent(name)}`;
  try {
    const html = await fetchURL(url);
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
    res.status(500).json({ error: "Failed: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Swim Times Server listening on port ${PORT}`);
});
