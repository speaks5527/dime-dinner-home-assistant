# Must stay above every FROM: an ARG declared after one is stage-scoped, so
# `FROM ${BUILD_FROM}` would expand to "" and BuildKit would abort with
# "base name should not be blank" despite the Supervisor passing --build-arg.
# The default covers Supervisor 2026.04+, which no longer supplies a fallback.
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.21

# ---------- build stage: compile the client, bundle the server ----------
# Shares the runtime's base image so both stages get the same Node.js major
# version; better-sqlite3's compiled binding is ABI-locked to the Node that
# built it and gets copied into the runtime stage as-is.
FROM ${BUILD_FROM} AS builder

RUN apk add --no-cache nodejs npm python3 make g++

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
    && npm prune --omit=dev

# ---------- runtime: Home Assistant add-on base ----------
FROM ${BUILD_FROM}

ENV NODE_ENV=production \
    PORT=5000 \
    DIME_DINNER_DB=/data/dime-dinner.db

# poppler-utils (main) gives pdfinfo/pdftotext/pdftoppm; tesseract-ocr and its
# English traineddata (community) handle ebooks whose pages are flattened
# images. On Alpine the language data is a separate package and is named
# tesseract-ocr-data-eng, not tesseract-ocr-eng.
RUN apk add --no-cache nodejs poppler-utils tesseract-ocr tesseract-ocr-data-eng \
    && pdftotext -v \
    && tesseract --list-langs

WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

COPY run.sh /run.sh
RUN chmod a+x /run.sh

# io.hass.version/arch/type are injected by the Supervisor at build time.
LABEL io.hass.name="Dime Dinner" \
      io.hass.description="Meal planner, grocery list and pantry panel" \
      io.hass.type="addon"

CMD [ "/run.sh" ]
