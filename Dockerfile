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
EXPOSE 10000
CMD ["node", "build/server.js"]
