FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA
WORKDIR /app
COPY upstream/package.json upstream/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY upstream/server.js ./server.js
COPY upstream/src ./src
COPY session-check.mjs ./session-check.mjs
USER node
CMD ["node", "--env-file=/run/kaspi/bridge.env", "server.js"]
