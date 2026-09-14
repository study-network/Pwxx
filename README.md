# PW STUDY NETWORK

A modern educational web platform with batch management, live & recorded lectures, interactive video player (HLS / DASH DRM support), study materials, schedules, and bookmarks.

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite 7, Tailwind CSS v4, Wouter, TanStack Query
- **Backend**: Express 5, TypeScript, Pino Logger
- **Video & DRM**: HLS.js, Shaka Player
- **UI Components**: Radix UI primitives, Lucide Icons, Framer Motion
- **Database & State**: Drizzle ORM (PostgreSQL) with in-memory & local fallback

## Monorepo Structure

```
artifacts/
  pw-clone/       — React 19 / Vite PWA Frontend
  api-server/     — Express 5 API Server
  og-worker/      — Cloudflare Worker for dynamic meta previews
lib/
  db/             — Drizzle schema and migrations
  api-client-react/ — React query hooks
  api-spec/       — Shared OpenAPI / Zod models
```

## Quick Start

### Installation

```bash
npm install
# or
pnpm install
```

### Development

```bash
npm run dev
```

### Production Build

```bash
npm run build
```

### Typecheck

```bash
npm run typecheck
```

## Docker

Build and run using Docker Compose:

```bash
docker-compose up --build
```
