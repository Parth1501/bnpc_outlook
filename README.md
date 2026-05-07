# BNPC Market Outlook

Daily AI-powered Indian stock market morning analysis site.
Built with Astro 4 (static output) + Tailwind CSS. Deployed to nginx on Oracle Cloud (OCI).

---

## Architecture

```
GitHub Actions (cron 08:00 IST weekdays)
  └── fetch-news.ts        → /tmp/raw-news.json
  └── fetch-market-data.ts → /tmp/raw-market.json
  └── analyze.ts           → src/data/analyses/YYYY-MM-DD.json
  └── verify-yesterday.ts  → patches yesterday's accuracy_review
  └── astro build          → dist/ (pure static HTML/CSS/JS)
  └── rsync                → OCI nginx /var/www/stock-outlook/
```

No Node.js runtime on the server. nginx serves static files only.

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/your-org/stock-outlook.git
cd stock-outlook
npm install
```

### 2. Local development

```bash
npm run dev       # Astro dev server — http://localhost:4321
npm run build     # Build static site to dist/
npm run preview   # Preview built site
```

### 3. Run the pipeline locally (generates today's analysis)

```bash
export ANTHROPIC_API_KEY=sk-ant-...

npm run pipeline
# Then:
npm run build
npm run preview
```

---

## GitHub Secrets required

Add these in **Settings → Secrets → Actions**:

| Secret | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key (`sk-ant-...`) |
| `OCI_HOST` | OCI server IP or hostname (e.g. `203.0.113.42`) |
| `OCI_USER` | SSH user on OCI (e.g. `ubuntu` or `opc`) |
| `OCI_SSH_KEY` | Private SSH key content (e.g. contents of `~/.ssh/id_ed25519`) |

The workflow runs on weekdays at 08:00 IST (02:30 UTC). Trigger manually via **Actions → Daily Market Analysis → Run workflow**.

---

## OCI Deployment

### One-time server setup

```bash
# SSH into your OCI instance
ssh ubuntu@YOUR_OCI_IP

# Install nginx
sudo apt update && sudo apt install -y nginx

# Create webroot
sudo mkdir -p /var/www/stock-outlook
sudo chown ubuntu:ubuntu /var/www/stock-outlook

# Set up nginx config
sudo nano /etc/nginx/sites-available/stock-outlook
```

Paste this nginx config:

```nginx
server {
    listen 80;
    server_name market.bnpc.in;  # or your IP for testing

    root /var/www/stock-outlook;
    index index.html;

    # Brotli (if module available) — otherwise just gzip
    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css application/javascript
               application/json image/svg+xml application/xml;
    gzip_min_length 1024;

    # Hashed static assets: 1 year immutable
    location /_assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # HTML: 1 day, must revalidate
    location ~* \.html$ {
        expires 1d;
        add_header Cache-Control "public, must-revalidate";
    }

    # RSS / XML: 1 hour
    location ~* \.(xml|rss)$ {
        expires 1h;
        add_header Cache-Control "public";
    }

    # SPA-style routing fallback
    error_page 404 /404.html;
    location / {
        try_files $uri $uri/ $uri.html =404;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/stock-outlook /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Manual rsync (what GitHub Actions runs)

```bash
rsync -avz --delete dist/ ubuntu@YOUR_OCI_IP:/var/www/stock-outlook/
```

### HTTPS (optional, free via Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d market.bnpc.in
```

---

## Adding a new analysis manually

1. Create `src/data/analyses/YYYY-MM-DD.json` matching the schema in `src/lib/types.ts`
2. `npm run build && rsync -avz dist/ ubuntu@OCI:/var/www/stock-outlook/`

Or just run the pipeline: `npm run pipeline && npm run build`

---

## Testing the cron locally

The workflow can be triggered manually from GitHub Actions UI.
To test the full pipeline without deploying:

```bash
# From the repo root:
export ANTHROPIC_API_KEY=sk-ant-...
npm run pipeline      # generates today's JSON
npm run build         # builds dist/
npm run preview       # serves at localhost:4321
```

---

## Adding the Gemini fallback

In `scripts/analyze.ts`, swap the `callClaude()` function with a Gemini call using the `@google/generative-ai` SDK. Use model `gemini-2.0-flash` (free tier). The prompt stays the same.

---

## File structure

```
src/
  data/analyses/YYYY-MM-DD.json   ← one file per trading day (the "database")
  components/                     ← Astro components (zero JS shipped by default)
  layouts/Layout.astro
  pages/
    index.astro                   ← today (loads latest JSON)
    archive/index.astro           ← last 30 days table
    archive/[date].astro          ← individual day
    rss.xml.ts                    ← RSS feed endpoint
scripts/
  fetch-news.ts                   ← RSS → /tmp/raw-news.json
  fetch-market-data.ts            ← Yahoo Finance → /tmp/raw-market.json
  analyze.ts                      ← Claude API → src/data/analyses/TODAY.json
  verify-yesterday.ts             ← patches accuracy_review into yesterday's JSON
  run-pipeline.ts                 ← orchestrator
.github/workflows/daily-build.yml
```

---

## Notes on dependencies added (beyond your spec)

| Package | Why |
|---|---|
| `rss-parser` (dev) | RSS feed parsing in `fetch-news.ts` |
| `@anthropic-ai/sdk` (dev) | Claude API in `analyze.ts` |
| `@astrojs/sitemap` | Sitemap generation (you requested sitemap) |
| `tsx` (dev) | Run TypeScript scripts directly |

All dev-only — none of these ship to the browser or run on OCI.
