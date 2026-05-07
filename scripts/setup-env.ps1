$envPath = Join-Path $PSScriptRoot "..\.env"
$defaultModel = "anthropic/claude-haiku-4.5"
$defaultSiteUrl = "https://yourdomain.com"

Write-Host ""
Write-Host "=== Stock Outlook .env Setup ===" -ForegroundColor Cyan
Write-Host "Press Enter to accept defaults where shown." -ForegroundColor DarkGray
Write-Host ""

$apiKey = Read-Host "OpenRouter API Key (required, starts with sk-or-v1-)"
while ([string]::IsNullOrWhiteSpace($apiKey)) {
  Write-Host "API key is required." -ForegroundColor Yellow
  $apiKey = Read-Host "OpenRouter API Key (required, starts with sk-or-v1-)"
}

Write-Host ""
Write-Host "Model examples:" -ForegroundColor DarkGray
Write-Host "  anthropic/claude-haiku-4.5" -ForegroundColor DarkGray
Write-Host "  openai/gpt-4o-mini" -ForegroundColor DarkGray
Write-Host "  google/gemini-2.0-flash-001" -ForegroundColor DarkGray
$modelInput = Read-Host "OpenRouter model [$defaultModel]"
$model = if ([string]::IsNullOrWhiteSpace($modelInput)) { $defaultModel } else { $modelInput.Trim() }

$siteInput = Read-Host "Site URL [$defaultSiteUrl]"
$siteUrl = if ([string]::IsNullOrWhiteSpace($siteInput)) { $defaultSiteUrl } else { $siteInput.Trim() }

$useMarketaux = Read-Host "Do you want to set MARKETAUX_KEY? (y/N)"
$marketaux = ""
if ($useMarketaux -match "^(y|yes)$") {
  $marketaux = Read-Host "MARKETAUX_KEY"
}

$useFinnhub = Read-Host "Do you want to set FINNHUB_API_KEY for economic calendar? (y/N)"
$finnhub = ""
if ($useFinnhub -match "^(y|yes)$") {
  $finnhub = Read-Host "FINNHUB_API_KEY"
}

$envContent = @(
  "OPENROUTER_API_KEY=$apiKey"
  "OPENROUTER_MODEL=$model"
  "SITE_URL=$siteUrl"
  "MARKETAUX_KEY=$marketaux"
  "FINNHUB_API_KEY=$finnhub"
) -join "`n"

Set-Content -Path $envPath -Value $envContent -Encoding UTF8
Write-Host ""
Write-Host "Saved .env to $envPath" -ForegroundColor Green
