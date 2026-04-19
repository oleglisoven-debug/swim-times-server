# Swim Times Server

A Node.js server that uses Puppeteer to fetch Irish swimmer times from Swimrankings.net.

## Endpoints

- `GET /search?name=Murphy` — Search for a swimmer by name (Ireland only)
- `GET /times?athleteId=1234567` — Fetch times for a specific athlete ID

## Deployment

Deployed on Railway. Connects to the Irish Swimming Qualifier Checker frontend.
