const NEWS_ONLY = process.env.NEWS_ONLY === 'true';
const Parser = require('rss-parser');

// Disguise the parser as a normal Google Chrome web browser to bypass News24 security
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  }
});

const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client using environment variables provided by GitHub Actions
const supabaseUrl = process.env.SUPABASE_URL || 'https://mjxqiyykihhgzrwrsryw.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; 
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// --- COLLECTOR FUNCTIONS ---

async function fetchNews24() {
  console.log("Fetching News24 data...");
  try {
    // News24 South Africa RSS feed
    const feed = await parser.parseURL('https://feeds.news24.com/articles/news24/SouthAfrica/rss');
    
    // Grab the top 5 most recent articles and format them for our dashboard
    const articles = feed.items.slice(0, 5).map(item => ({
      title: item.title,
      description: item.contentSnippet || "No description provided.",
      source_url: item.link,
      category: "news",
      source_name: "News24",
      incident_time: item.isoDate || new Date().toISOString(),
      province: "GLOBAL", // We can add keyword matching for provinces later!
      status: "active",
      severity: 3 // Stable/Info severity
    }));

    console.log(`✅ Successfully fetched ${articles.length} articles from News24!`);
    console.log("Sample article:", articles[0]);

    if (supabase) {
      console.log("Pushing to Supabase...");
      const { error } = await supabase.from('live_incidents').upsert(articles, { onConflict: 'source_url' });
      if (error) {
        console.error("❌ Error inserting to Supabase:", error.message);
      } else {
        console.log("✅ Successfully pushed News24 articles to Supabase!");
      }
    } else {
      console.log("⚠️ Supabase credentials missing in environment. Skipping database insert.");
    }
  } catch (error) {
    console.error("❌ Error fetching News24:", error.message);
  }
}

async function fetchSAPS() {
  console.log("Fetching SAPS press releases...");
  // TODO: Add logic to pull police reports and send to database
}

async function fetchTraffic() {
  console.log("Fetching traffic data...");
  // TODO: Add logic for SANRAL / TomTom API
}

async function fetchEskom() {
  console.log("Fetching Eskom loadshedding data...");
  // TODO: Add logic for EskomSePush API
}

async function fetchFinance() {
  console.log("Fetching financial data...");
  // TODO: Add logic for ZAR exchange rates and JSE data
}

// --- MAIN EXECUTION CYCLE ---

async function runIngestionCycle() {
  console.log(`Starting ingestion cycle. NEWS_ONLY mode: ${NEWS_ONLY}`);

  try {
    console.log("Starting News & Intel collectors...");
    await fetchNews24();
    await fetchSAPS();

    if (!NEWS_ONLY) {
      console.log("Starting infrastructure, traffic, and finance collectors...");
      await fetchTraffic();
      await fetchEskom();
      await fetchFinance();
    } else {
      console.log("Skipping heavy collectors because NEWS_ONLY is true.");
    }
    
    console.log("Ingestion cycle complete.");
  } catch (error) {
    console.error("Error during ingestion cycle:", error);
    process.exit(1);
  }
}

// Start the worker
runIngestionCycle();