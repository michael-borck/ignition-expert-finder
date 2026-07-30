# Two stages so the runtime image carries no build toolchain.
# node:sqlite is built in, so there is no native module to compile and no
# python/gcc layer - the whole image is Node plus the app.

FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY shared/ ./shared/
COPY server/ ./server/
COPY web/ ./web/
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Configuration only. The image is published to a container registry, and
# clinician emails, biographies and photographs have no business travelling
# into layer caches and CI runners. A fresh deployment starts with an empty
# bench and the organiser uploads the two source documents at /admin.
COPY data/areas.json ./data/areas.json

# Normalise ownership and permissions rather than inheriting whatever the build
# host had. Checked-out sources are usually 644, but a copy from a volume that
# does not carry POSIX modes - an exFAT external disk, for one - arrives as
# 0700 root-only, and the container runs as an unprivileged user.
RUN chown -R node:node /app && chmod -R a+rX /app/data /app/dist

# The event log, an uploaded bench and uploaded headshots all live on a volume;
# without one, the week's data dies with the container. See docker-compose.yml.
#
# The directory is created and chowned here rather than left to Docker: a fresh
# named volume inherits the ownership of the image directory it is mounted over,
# and the container runs unprivileged. (A bind mount takes its ownership from
# the host instead - chown it to uid 1000 there.)
ENV DATABASE_PATH=/data/expert-finder.sqlite \
    BENCH_PATH=/data/clinicians.json \
    HEADSHOTS_PATH=/data/headshots \
    SEED_DIR=/seed
RUN mkdir -p /data/headshots && chown -R node:node /data
VOLUME /data

EXPOSE 3210
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:${PORT:-3210}/api/bench').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
