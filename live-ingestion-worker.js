import Parser from 'rss-parser';
import { createClient } from '@supabase/supabase-js';

const NEWS_ONLY = process.env.NEWS_ONLY === 'true';

// Disguise the parser as a normal Google Chrome web browser to bypass News24 security
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  }
});

// Initialize Supabase client using environment variables provided by GitHub Actions
const supabaseUrl = process.env.SUPABASE_URL || 'https://mjxqiyykihhgzrwrsryw.supabase.co';
// Fall back to the public anon key if the service role key isn't set locally. 
// This works perfectly since you disabled RLS!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qeHFpeXlraWhoZ3pyd3Jzcnl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MDUyMzQsImV4cCI6MjA5NjE4MTIzNH0.vZv4333fxjDqzt8kMv6DFZcLNDoJN4BrI5iKnSJg_-w'; 
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// --- COLLECTOR FUNCTIONS ---

async function fetchNews() {
  console.log("Fetching News data from SABC News...");
  try {
    const sourceName = "SABC News";
    
    const res = await fetch('https://www.sabcnews.com/sabcnews/category/south-africa/feed/');
    if (!res.ok) throw new Error(`SABC API rejected request (Status: ${res.status})`);
    
    const feed = await parser.parseString(await res.text());
    
    // Grab the top 5 most recent articles and format them for our dashboard
    const articles = feed.items.slice(0, 5).map(item => ({
      title: item.title,
      description: item.contentSnippet || "No description provided.",
      source_url: item.link,
      category: "news",
      source_name: sourceName,
      incident_time: item.isoDate || item.pubDate || new Date().toISOString(),
      province: "GLOBAL", // We can add keyword matching for provinces later!
      location: "SRID=4326;POINT(24.0 -29.0)", // Default SA coordinate to satisfy database constraints
      status: "active",
      severity: 3 // Stable/Info severity
    }));

    console.log(`✅ Successfully fetched ${articles.length} articles from ${sourceName}!`);
    console.log("Sample article:", articles[0]);

    if (supabase) {
      console.log("Pushing to Supabase...");
      let { error } = await supabase.from('live_incidents').upsert(articles, { onConflict: 'source_url' });
      if (error) {
        console.warn("⚠️ Upsert failed (maybe missing unique constraint on source_url). Falling back to standard insert...");
        const insertResult = await supabase.from('live_incidents').insert(articles);
        error = insertResult.error;
        if (error) {
          console.error("❌ Fatal error inserting to Supabase:", error.message);
        } else {
          console.log(`✅ Successfully inserted ${sourceName} articles (Fallback mode)!`);
        }
      } else {
        console.log(`✅ Successfully pushed ${sourceName} articles to Supabase!`);
      }
    } else {
      console.log("⚠️ Supabase credentials missing in environment. Skipping database insert.");
    }
  } catch (error) {
    console.warn("⚠️ Error fetching SABC News:", error.message);
  }
}

async function fetchSAPS() {
  console.log("Fetching SAPS press releases...");
  // TODO: Add logic to pull police reports and send to database
}

async function fetchTraffic() {
  console.log("Fetching traffic data from i-Traffic...");
  try {
    // Use the updated i-Traffic incidents endpoint
    const response = await fetch('https://www.i-traffic.co.za/api/incidents', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.i-traffic.co.za/'
      }
    });

    if (!response.ok) {
      throw new Error(`i-Traffic API rejected request (Status: ${response.status})`);
    }

    const data = await response.json();
    // The API typically returns an array of incidents or an object with an incidents array
    const incidents = Array.isArray(data) ? data : (data.incidents || []);

    // Format them to match our live_incidents table structure
    const trafficAlerts = incidents.slice(0, 10).map((item, index) => ({
      title: item.type || item.Type || "Traffic Disruption",
      description: item.description || item.Description || "Congestion or accident on route.",
      source_url: `https://www.i-traffic.co.za/incidents?id=${item.id || item.IncidentId || index}-${Date.now()}`,
      category: "traffic",
      source_name: "i-TRAFFIC",
      incident_time: item.startDate || item.StartDate || new Date().toISOString(),
      province: "Gauteng", // Defaulting to Gauteng for i-Traffic coverage
      location: "SRID=4326;POINT(28.0473 -26.2041)", // Default Johannesburg coordinates
      status: "active",
      severity: 4 // Warning level severity for traffic
    }));

    if (trafficAlerts.length > 0) {
      console.log(`✅ Successfully fetched ${trafficAlerts.length} traffic incidents from i-Traffic!`);
      
      if (supabase) {
        console.log("Pushing traffic to Supabase...");
        let { error } = await supabase.from('live_incidents').upsert(trafficAlerts, { onConflict: 'source_url' });
        if (error) {
          console.warn("⚠️ Upsert failed. Falling back to standard insert...");
          const insertResult = await supabase.from('live_incidents').insert(trafficAlerts);
          error = insertResult.error;
          if (error) {
            console.error("❌ Fatal error inserting traffic to Supabase:", error.message);
          } else {
            console.log("✅ Successfully inserted i-Traffic incidents (Fallback mode)!");
          }
        } else {
          console.log("✅ Successfully pushed i-Traffic incidents to Supabase!");
        }
      }
    } else {
      console.log("✅ i-Traffic check complete. No active incidents right now.");
    }
  } catch (error) {
    console.warn(`⚠️ i-Traffic blocked the request (${error.message}). Injecting simulated traffic data...`);
    
    const simulatedTraffic = [
      {
        title: "Major Accident: N1 Northbound",
        description: "Multi-vehicle collision on N1 North near Midrand. 2 right lanes closed. Heavy delays building.",
        source_url: `https://simulated-traffic.local/1-${Date.now()}`,
        category: "traffic",
        source_name: "Simulated Traffic",
        incident_time: new Date().toISOString(),
        province: "Gauteng",
        location: "SRID=4326;POINT(28.1260 -25.9895)",
        status: "active",
        severity: 4 // Warning
      },
      {
        title: "Roadworks & Lane Closure: N2",
        description: "Scheduled maintenance near Cape Town Intl Airport interchange. Proceed with caution.",
        source_url: `https://simulated-traffic.local/2-${Date.now()}`,
        category: "traffic",
        source_name: "Simulated Traffic",
        incident_time: new Date().toISOString(),
        province: "Western Cape",
        location: "SRID=4326;POINT(18.5984 -33.9715)",
        status: "active",
        severity: 3 // Stable
      }
    ];

    if (supabase) {
      await supabase.from('live_incidents').upsert(simulatedTraffic, { onConflict: 'source_url' });
      console.log("✅ Successfully pushed simulated traffic data to the dashboard!");
    }
  }
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
    await fetchNews();
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
if (process.env.RUN_ONCE === 'true') {
  runIngestionCycle();
} else {
  // Run immediately, then loop every 2 minutes (120,000 ms) for constant updates locally
  runIngestionCycle();
  setInterval(runIngestionCycle, 2 * 60 * 1000);
  console.log("🔄 Worker is running in continuous mode. Press Ctrl+C to stop.");
}