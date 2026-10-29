# The Playwright image carries the Chromium build (and its system libraries)
# that matches package-lock's playwright 1.48.2, which renders the PDFs.
FROM mcr.microsoft.com/playwright:v1.48.2-jammy

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Builds the page, compiles the server to build/server.js and cleans the fixed
# Matam page; then build-only tools (TypeScript, Vite, React sources) go.
RUN npm run build && npm prune --omit=dev

# Work (screenshots, the open booklet, pinned defaults) lives in /data:
# mount a persistent disk there or it is lost on every restart.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=10000 DATA_DIR=/data
# Image cleaning (sharp, OCR) frees its memory, but glibc's per-thread arenas
# kept it: the server sat at ~470 MB after making a booklet's verses and the
# PDF export then ran the 512 MB host out of memory. Two arenas and an eager
# trim give it back (~60 MB idle).
ENV MALLOC_ARENA_MAX=2 MALLOC_TRIM_THRESHOLD_=131072
EXPOSE 10000
CMD ["node", "build/server.js"]
