# Docker Deployment Guide

This guide helps you deploy the entire Focas VSL application using Docker.

## What's Included

- ✅ **Next.js Application** (frontend + API routes)
- ✅ **MongoDB Database** (fully containerized)
- ✅ **All dependencies** (pre-configured)
- ✅ **Health checks** (automatic monitoring)
- ✅ **Volume persistence** (data survives container restarts)

## Prerequisites

1. **Docker** installed ([download](https://www.docker.com/products/docker-desktop))
2. **Docker Compose** (usually comes with Docker Desktop)
3. **Environment variables** from your `.env` file

## Quick Start (Local Development)

### 1. Setup Environment Variables

```bash
cp .env.docker .env.docker.local
```

Then edit `.env.docker.local` and add your actual values:
- `WATI_TOKEN`
- `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`
- `BUNNY_STREAM_VIDEO_ID`, `BUNNY_STREAM_EMBED_URL`

### 2. Build & Start Containers

```bash
# Build Docker image (first time only)
docker-compose build

# Start the application
docker-compose up
```

The app will be available at `http://localhost:3000`

MongoDB will be available at `mongodb://admin:password123@localhost:27017/focas`

### 3. View Logs

```bash
# Follow all container logs
docker-compose logs -f

# Follow only app logs
docker-compose logs -f app

# Follow only MongoDB logs
docker-compose logs -f mongodb
```

### 4. Stop Containers

```bash
docker-compose down
```

To remove all data (including MongoDB):
```bash
docker-compose down -v
```

---

## Production Deployment

### Option A: Deploy to AWS (ECS/EC2)

1. Push Docker image to ECR (Elastic Container Registry)
2. Create ECS cluster
3. Deploy docker-compose as ECS task definition
4. Set environment variables in AWS console

### Option B: Deploy to DigitalOcean App Platform

1. Connect GitHub repo
2. Upload `Dockerfile`
3. Add MongoDB service
4. Configure environment variables
5. Deploy

### Option C: Deploy to Railway.app

1. Connect GitHub
2. Add MongoDB service
3. Deploy - Railway handles Docker automatically

### Option D: Deploy to Render.com

1. Connect GitHub
2. Create Web Service from Dockerfile
3. Add PostgreSQL or MongoDB service
4. Configure environment variables

### Option E: Self-Hosted (VPS)

```bash
# SSH into your server
ssh user@your-server.com

# Clone repository
git clone <your-repo-url>
cd focasvsl

# Create environment file
nano .env.docker

# Start containers
docker-compose -f docker-compose.yml up -d
```

---

## Environment Variables for Production

```env
# Use your actual domain
APP_URL=https://yourdomain.com

# WATI
WATI_TOKEN=wati_xxx...
WATI_CHANNEL_PHONE=916383514285

# Zoho
ZOHO_CLIENT_ID=1000.xxx
ZOHO_CLIENT_SECRET=xxx
ZOHO_REFRESH_TOKEN=1000.xxx

# Bunny Stream
BUNNY_STREAM_VIDEO_ID=xxx
BUNNY_STREAM_EMBED_URL=https://player.mediadelivery.net/play/xxx
```

---

## Docker Commands Reference

```bash
# Start in background
docker-compose up -d

# Stop containers (keep data)
docker-compose stop

# Remove containers (keep data)
docker-compose down

# Remove everything (including data!)
docker-compose down -v

# Rebuild image
docker-compose build --no-cache

# Execute command in running container
docker-compose exec app npm run build

# View MongoDB data
docker-compose exec mongodb mongosh -u admin -p password123 focas

# Check container status
docker-compose ps

# Restart a service
docker-compose restart app
```

---

## Troubleshooting

### Container won't start

```bash
# Check logs
docker-compose logs app

# Rebuild without cache
docker-compose build --no-cache
docker-compose up
```

### MongoDB connection failed

```bash
# Check MongoDB logs
docker-compose logs mongodb

# Check if MongoDB is healthy
docker-compose ps
```

### Port already in use

If port 3000 or 27017 is already used:

```yaml
# Edit docker-compose.yml
ports:
  - "3001:3000"  # Use 3001 instead
```

### Data not persisting

Docker volumes might have permission issues:

```bash
# Remove volumes and restart
docker-compose down -v
docker-compose up
```

---

## Scaling for Production

### Use Environment-Specific Files

```bash
# Development
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up

# Production
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Enable HTTPS

```bash
# Update docker-compose to use reverse proxy (Nginx)
# Add Let's Encrypt SSL certificates
```

### Monitor & Logs

```bash
# Use ELK Stack or similar for log aggregation
# Monitor with Prometheus + Grafana
```

---

## Next Steps

1. ✅ Test locally with `docker-compose up`
2. ✅ Verify webhooks work (MongoDB data created)
3. ✅ Choose production platform
4. ✅ Set up CI/CD (GitHub Actions → Docker Hub → Deploy)
5. ✅ Configure custom domain & SSL

---

**Need help?** Check the main README.md or contact support.
