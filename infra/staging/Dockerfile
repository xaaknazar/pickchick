FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS build
WORKDIR /app
RUN npm install --global pnpm@11.19.0
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
# Catalog photo uploads load the prebuilt libvips for this platform (linux-x64 glibc) lazily;
# fail the image build, not the first upload, when it is missing.
RUN node -e "require('./packages/catalog-admin/node_modules/sharp')({create:{width:1,height:1,channels:3,background:'#000'}}).webp().toBuffer().then((b)=>{if(b.length<16)process.exit(1)})"

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
CMD ["node", "services/api/dist/main.js"]
