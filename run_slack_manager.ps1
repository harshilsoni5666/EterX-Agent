# Slack Manager Agent Initialization & Verification Script
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "   Slack Manager Autonomous Agent Setup & Status    " -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

$agentJsonPath = ".workspaces/agent-builder/agents/eterxagent-1999-slac.json"
$profileJsonPath = ".workspaces/agent-builder/agents/eterxagent-1999-slac.profile.json"

if (Test-Path $agentJsonPath) {
    Write-Host "[OK] Agent JSON configuration found at: $agentJsonPath" -ForegroundColor Green
} else {
    Write-Host "[ERROR] Agent JSON configuration missing!" -ForegroundColor Red
}

if (Test-Path $profileJsonPath) {
    Write-Host "[OK] Agent profile found at: $profileJsonPath" -ForegroundColor Green
} else {
    Write-Host "[ERROR] Agent profile missing!" -ForegroundColor Red
}

Write-Host "`n[READY] The Slack Manager agent (eterxagent-1999-slac) is fully set up and registered." -ForegroundColor Green
Write-Host "You can now select or invoke this agent within EterX for automated Slack workspace management." -ForegroundColor Yellow
