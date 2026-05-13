# OCI Deployment Guide (HTTPS on Port 5555)

This guide deploys `stock-outlook` to OCI with:

- Static Astro build via Nginx
- HTTPS enabled with Let's Encrypt
- Public URL: `https://bnpc.unisolution.co.in:5555`
- Daily cron pipeline on the OCI box

---

## 1) Connect to OCI and install dependencies

```bash
ssh ubuntu@<OCI_PUBLIC_IP>
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx rsync curl git
```

Install Node.js 20 + pnpm:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm i -g pnpm
```

---

## 2) Clone and prepare project

```bash
cd /home/ubuntu
git clone <YOUR_REPO_URL> stock-outlook
cd stock-outlook
pnpm install
```

Create env file:

```bash
cp .env.example .env
nano .env
```

Set values:

```env
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=anthropic/claude-haiku-4.5
SITE_URL=https://bnpc.unisolution.co.in:5555
MARKETAUX_KEY=...
```

Lock permissions:

```bash
chmod 600 .env
```

---

## 3) First build and publish static files

```bash
mkdir -p /var/www/stock-outlook
pnpm build
rsync -a --delete dist/ /var/www/stock-outlook/
```

---

## 4) Configure Nginx

Create config:

```bash
sudo nano /etc/nginx/sites-available/stock-outlook
```

Paste:

```nginx
server {
    listen 80;
    server_name bnpc.unisolution.co.in;

    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host:5555$request_uri; }
}

server {
    listen 5555 ssl http2;
    server_name bnpc.unisolution.co.in;

    root /var/www/stock-outlook;
    index index.html;

    ssl_certificate /etc/letsencrypt/live/bnpc.unisolution.co.in/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bnpc.unisolution.co.in/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml application/xml;

    location /_assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location ~* \.html$ {
        expires 1h;
        add_header Cache-Control "public, must-revalidate";
    }

    location / {
        try_files $uri $uri/ $uri.html =404;
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/stock-outlook /etc/nginx/sites-enabled/stock-outlook
sudo nginx -t
sudo systemctl reload nginx
```

---

## 5) Enable SSL certificate (Let's Encrypt)

Make sure DNS already points to OCI (`bnpc.unisolution.co.in`) and port 80 is open.

```bash
sudo certbot --nginx -d bnpc.unisolution.co.in
sudo nginx -t
sudo systemctl reload nginx
```

---

## 6) Open required ports

Open both OCI NSG/Security List and OS firewall.

Required inbound ports:

- `22` (SSH)
- `80` (certbot + redirect)
- `5555` (HTTPS app)

If UFW enabled:

```bash
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 5555
sudo ufw reload
```

---

## 7) Create daily run script (OCI)

Create:

```bash
nano /home/ubuntu/stock-outlook/scripts/run-daily.sh
chmod +x /home/ubuntu/stock-outlook/scripts/run-daily.sh
```

Script content:

```bash
#!/usr/bin/env bash
set -euo pipefail

cd /home/ubuntu/stock-outlook
export NODE_OPTIONS="--max-old-space-size=384"

# load env
set -a
source .env
set +a

LOG_DIR="/var/log/outlook"
mkdir -p "$LOG_DIR"
LOGFILE="$LOG_DIR/$(date +%Y-%m-%d).log"
exec >>"$LOGFILE" 2>&1

echo "=== $(date -Iseconds) START ==="

pnpm fetch-news
pnpm fetch-market
pnpm verify
pnpm analyze

rm -rf dist-new
pnpm build
cp -r dist dist-new
rsync -a --delete dist-new/ /var/www/stock-outlook/
rm -rf dist-new

echo "=== $(date -Iseconds) DONE ==="
```

---

## 8) Add cron job (07:30 IST, weekdays only — not Sat/Sun)

Indian cash market is closed **Saturday–Sunday**. Cron below runs **every weekday morning** (`1–5` = Monday–Friday in the timezone cron uses).

Setting **`CRON_TZ=Asia/Kolkata`** makes “weekday” and “07:30” match IST, avoiding UTC-vs-IST weekday edge cases.

```bash
crontab -e
```

Add:

```cron
CRON_TZ=Asia/Kolkata
30 7 * * 1-5 /home/ubuntu/stock-outlook/scripts/run-daily.sh
```

(`30 7 * * 1-5` = minute 30, hour 7, Monday–Friday, in `Asia/Kolkata`.)

---

## 9) Test everything now

Manual run:

```bash
cd /home/ubuntu/stock-outlook
bash scripts/run-daily.sh
```

Verify:

- Site opens at `https://bnpc.unisolution.co.in:5555`
- Latest build in `/var/www/stock-outlook`
- Logs present in `/var/log/outlook/`

---

## 10) Troubleshooting

- Check Nginx:
  ```bash
  sudo nginx -t && sudo systemctl status nginx
  ```
- Check cert:
  ```bash
  sudo certbot certificates
  ```
- Check cron logs:
  ```bash
  ls -lah /var/log/outlook
  tail -n 200 /var/log/outlook/$(date +%Y-%m-%d).log
  ```
- If DNS works but HTTPS on 5555 fails, confirm OCI ingress on `5555`.

