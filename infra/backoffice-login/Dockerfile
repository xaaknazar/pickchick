FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA
WORKDIR /app
COPY server.mjs staff-auth.mjs ./
COPY dist ./dist
USER node
EXPOSE 4177
CMD ["node", "server.mjs"]
