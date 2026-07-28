# ---------- build stage: compile the client, bundle the server ----------
FROM node:20-alpine AS builder

WORKDIR /build
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
    && npm prune --omit=dev

# ---------- runtime: Home Assistant add-on base ----------
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.19
FROM ${BUILD_FROM}

ENV NODE_ENV=production \
    PORT=5000 \
    DIME_DINNER_DB=/data/dime-dinner.db

RUN apk add --no-cache nodejs

WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

COPY run.sh /run.sh
RUN chmod a+x /run.sh

LABEL io.hass.name="Dime Dinner" \
      io.hass.description="Meal planner, grocery list and pantry panel" \
      io.hass.type="addon" \
      io.hass.version="1.0.0"

CMD [ "/run.sh" ]
