# Credible — privacy-first web analytics.
#
# There is no build stage and no dependency installation, because Credible has
# zero npm dependencies: the image is the official Node runtime plus this
# repository. That keeps it small, auditable, and quick to rebuild.
#
#   docker build -t credible .
#   docker run -d -p 8000:8000 -v credible_data:/data credible
FROM node:22-alpine

# Storage lives on a volume so the database survives image upgrades.
ENV CREDIBLE_DATA_DIR=/data \
    CREDIBLE_HOST=0.0.0.0 \
    CREDIBLE_PORT=8000 \
    NODE_ENV=production

WORKDIR /app

# Copy the application. .dockerignore keeps local data and git metadata out.
COPY --chown=node:node . .

# The data directory is created and handed to the unprivileged user at build
# time so that a fresh named volume inherits the correct ownership.
RUN mkdir -p /data && chown -R node:node /data

# Never run an internet-facing ingest endpoint as root.
USER node

VOLUME ["/data"]
EXPOSE 8000

# Uses the built-in fetch of Node 22 rather than adding curl or wget to the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CREDIBLE_PORT||8000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "bin/credible.js", "serve"]
